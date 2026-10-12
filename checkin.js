'use strict';
/*
 * wb-trae-checkin v1.3.1
 * 双平台每日积分签到：WorkBuddy + TRAE SOLO CN / Trae CN（国内版）
 *
 * - 只读本机登录态文件，不修改、不外传，日志永不打印 token
 * - 幂等安全：已签自动跳过，重复运行不会多领
 * - 应急预案：
 *   1) 真实互联网三重探测（NCSI 内容校验 + API JSON 应答），真断网等 20 分钟
 *   2) 断线重试：请求级重试 3 次（间隔 15 秒），抗 Wi-Fi 闪断
 *   3) 回查确认：领取接口报成功后，再查状态确认"已签到"才算成功
 *   4) 登录态文件竞态：客户端周期性重写文件，用递增退避重试（约 30 秒窗口）
 *   5) 9074 限流：自动换设备号重试
 *   6) 调度层：计划任务一天 4 时段（00:05/09:00/12:30/19:00）+ 每小时兜底
 *      + 每次登录后 30 秒；另有常驻 watcher.js 兜底（见 watcher.js）
 * - 桌面通知（v1.3.1 重写：WinRT Toast，延迟汇报 + 抗误报）：
 *   新领取成功 → 立即弹系统通知横幅；锁屏时段成功未汇报 → 你登录用电脑时补弹一次；
 *   登录态持续失败 ≥30 分钟才判定真失效并提醒（单次失败多为文件竞态，静默）；
 *   其他失败仅 18 点后提醒。设 CHECKIN_NOTIFY=0 可彻底关闭通知。
 *   （旧版 NotifyIcon 气泡/ToastNotificationManager 在本机 Win11 均不可见，
 *     现改用 spawnSync + WinRT Toast + WorkBuddy AUMID，详见函数注释）
 * - 隐藏模式：node checkin.js toast-test 发送测试通知
 *
 * 依赖：Node.js >= 18（零 npm 依赖）
 * 用法: node checkin.js [auto|silent|status|toast-test] [workbuddy|trae]
 * 退出码: 0=全部完成(含已签/未开放) 2=有未完成项(需补跑或人工处理) 1=脚本异常
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = __dirname;
const LOG_FILE = process.env.CHECKIN_LOG || path.join(BASE, 'signin.log');
const DEV_FILE = path.join(BASE, 'trae_device_id.json');

const argMode = (process.argv[2] || 'auto').toLowerCase(); // auto | silent | status
const argOnly = (process.argv[3] || '').toLowerCase();     // '' | workbuddy | trae
const SILENT = argMode === 'silent';
const STATUS_ONLY = argMode === 'status';

function ts() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function out(line) {
  const full = `[${ts()}] ${line}`;
  try { fs.appendFileSync(LOG_FILE, full + '\n', 'utf8'); } catch (e) { /* 日志失败不影响主流程 */ }
  if (!SILENT) console.log(full);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function postJson(url, headers, body, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

// 请求级重试：网络异常（DNS 解析失败/连接重置/超时）时重试，抗 Wi-Fi 闪断
async function postJsonRetry(url, headers, body, tries = 3, gapMs = 15000) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await postJson(url, headers, body); }
    catch (e) {
      last = e;
      if (i < tries - 1) await sleep(gapMs);
    }
  }
  throw last;
}

// 真实互联网探测（三重校验，防“网卡连着但没网/网页认证劫持”）：
// 1) NCSI：Windows 同款联网检测，校验返回内容（认证门户伪造不了）
// 2) API JSON 探测：不带凭证 POST 两个签到接口，能拿到含 code 的 JSON = 真实触达服务
// 任一通过即视为有网；全部失败 = 真实断网，继续等待
async function probeNcsi() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch('http://www.msftconnecttest.com/connecttest.txt', { signal: ctrl.signal });
    const t = await res.text();
    return t.includes('Microsoft Connect Test');
  } catch (e) { return false; }
  finally { clearTimeout(timer); }
}
async function probeApiJson(url) {
  try {
    const r = await postJson(url, { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }, {}, 8000);
    return !!(r.json && typeof r.json.code !== 'undefined');
  } catch (e) { return false; }
}
async function ensureOnline(maxWaitMs = 1200000, gapMs = 30000) {
  const start = Date.now();
  let attempt = 0;
  while (true) {
    attempt++;
    const [ncsi, wbOk, traeOk] = await Promise.all([
      probeNcsi(),
      probeApiJson('https://www.codebuddy.cn/v2/billing/meter/checkin-activity-status'),
      probeApiJson('https://api.trae.cn/trae/api/v2/ug/checkin_credits/status'),
    ]);
    if (ncsi || wbOk || traeOk) return true;
    if (Date.now() - start >= maxWaitMs) return false;
    out(`NETWORK | 等待真实互联网…（第 ${attempt} 次未通，30 秒后重试，最长等 20 分钟）`);
    await sleep(gapMs);
  }
}

/* ==================== Windows 桌面通知 ==================== */

// 桌面通知：WinRT Toast（系统原生通知横幅）。
//
// 2026-10-12 深度排查结论（重要，勿随意改回）：
//   1) 旧方案 NotifyIcon.ShowBalloonTip 在本机 Win11 被系统静默丢弃——调用不报错，
//      但屏幕上什么也不显示（截图实测确认）；
//   2) 唯一能弹出系统横幅的通道是 WinRT ToastNotificationManager；
//   3) 绝对不要用 detached:true —— 计划任务环境下 detached 子进程无法执行
//      （三变体矩阵实测：detached 必失败，非 detached 必成功）；
//   4) 也不要依赖"父进程退出后子进程还在跑" —— Task Scheduler 在任务主进程退出时
//      会清理整个进程树（实测：node 立即退出会杀掉未完成的子进程）；
//   5) 因此这里用 spawnSync 同步等待（实测约 1 秒），确保通知发出后再继续；
//   6) AUMID 用 WorkBuddy 自己的 "WorkBuddy.WorkBuddy"（开始菜单已注册），
//      通知显示为 WorkBuddy 应用而不是 Windows PowerShell。
//
// 设 CHECKIN_NOTIFY=0 可彻底关闭通知
function toast(title, msg) {
  if (process.env.CHECKIN_NOTIFY === '0') return;
  try {
    // XML 转义（& < >）→ 再做 PowerShell 单引号字符串转义（' → ''）
    const escXml = s => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/'/g, "''");
    const ps = [
      '$ErrorActionPreference="Continue";',
      'try {',
      '  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;',
      '  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null;',
      '  $xmlStr = \'<toast duration="long"><visual><binding template="ToastGeneric"><text>' + escXml(String(title).slice(0, 120)) + '</text><text>' + escXml(String(msg).slice(0, 200)) + '</text></binding></visual></toast>\';',
      '  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument;',
      '  $xml.LoadXml($xmlStr);',
      '  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml);',
      '  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("WorkBuddy.WorkBuddy").Show($toast);',
      '} catch { }'
    ].join('\n');
    const enc = Buffer.from(ps, 'utf16le').toString('base64');
    // spawnSync（同步等待约 1 秒）：不能 detached（detached 子进程在计划任务环境下无法执行），
    // 也不能不等（node 退出时 Task Scheduler 会杀掉未完成的子进程）。
    require('child_process').spawnSync('powershell.exe',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', enc],
      { windowsHide: true, stdio: 'ignore', timeout: 25000 });
  } catch (e) { out('NOTIFY | 通知发送失败：' + e.message); }
}

/* ==================== WorkBuddy ==================== */

const WB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const WB_HOSTS = ['https://www.codebuddy.cn/v2/billing/meter', 'https://copilot.tencent.com/billing/meter'];
const WB_STATUS_EPS = ['checkin-activity-status', 'checkin-status'];

async function wbLoadToken() {
  // 客户端会周期性重写该文件（瞬间缺失/半截 JSON）。
  // 2026-10-07 首次踩坑用固定 1.5s×5 重试，10-10 实测仍会偶发失败（客户端写文件窗口比预期长）。
  // 改为递增退避：1.5s → 3s → 5s → 8s → 12s，总窗口约 30 秒，足以跨过写入期。
  const p = path.join(process.env.LOCALAPPDATA || '', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
  const BACKOFF = [1500, 3000, 5000, 8000, 12000];
  let lastErr = '未找到 WorkBuddy 登录态文件，请先登录 WorkBuddy 桌面端';
  for (let i = 0; i <= BACKOFF.length; i++) {
    if (fs.existsSync(p)) {
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        const token = j && j.auth && j.auth.accessToken;
        if (token) return { token };
        lastErr = '登录态文件中无 accessToken，请重新登录 WorkBuddy 桌面端';
      } catch (e) {
        lastErr = '登录态文件解析失败：' + e.message;
      }
    }
    if (i < BACKOFF.length) await sleep(BACKOFF[i]);
  }
  return { err: lastErr + '（递增退避重试 ' + BACKOFF.length + ' 次后仍读取失败）' };
}

function wbFindCheckedIn(j) {
  // 实测返回：data.today_checked_in（2026-10 亲测），兼容其他形态
  const roots = [j && j.data, j];
  for (const r of roots) {
    if (!r || typeof r !== 'object') continue;
    for (const k of ['today_checked_in', 'checked_in', 'checkedIn', 'hasCheckin', 'isCheckedIn', 'checked']) {
      if (typeof r[k] === 'boolean') return r[k];
    }
  }
  return null;
}

async function wbQueryStatus(headers) {
  // 返回 { checked: true|false|null, detail: obj|null }
  for (const h of WB_HOSTS) {
    for (const ep of WB_STATUS_EPS) {
      try {
        const r = await postJsonRetry(`${h}/${ep}`, headers, {}, 2);
        if (r.json) {
          const c = wbFindCheckedIn(r.json);
          if (c !== null) return { checked: c, detail: r.json.data || {} };
        }
      } catch (e) { /* 下一个 */ }
    }
  }
  return { checked: null, detail: null };
}

function wbDetailBits(d) {
  const bits = [];
  if (!d) return bits;
  const pts = d.today_credit ?? d.daily_credit ?? d.points ?? '';
  if (pts !== '') bits.push(`本次 +${pts}`);
  if (d.streak_days !== undefined) bits.push(`连续 ${d.streak_days} 天`);
  if (d.total_credits !== undefined) bits.push(`累计 ${d.total_credits} 积分`);
  return bits;
}

async function wbCheckin() {
  const t = await wbLoadToken();
  if (t.err) return { result: 'NO_AUTH', report: 'WorkBuddy：' + t.err };
  const headers = {
    'Authorization': 'Bearer ' + t.token,
    'Content-Type': 'application/json',
    'User-Agent': WB_UA, // 服务端要求浏览器 UA，否则裸 400
    'Referer': 'https://www.codebuddy.cn/',
    'Origin': 'https://www.codebuddy.cn',
  };

  // 1) 查询今日是否已签
  const st = await wbQueryStatus(headers);
  if (st.checked === true) {
    const bits = wbDetailBits(st.detail).filter(b => !b.startsWith('本次'));
    return { result: 'ALREADY', report: 'WorkBuddy：今日已签到' + (bits.length ? '（' + bits.join('，') + '）' : '') };
  }

  // 2) 领取 + 回查确认（最多 2 轮：领 → 回查；回查说没签 → 再领一次）
  let lastErr = null;
  for (let round = 0; round < 2; round++) {
    let claimed = null;
    for (const h of WB_HOSTS) {
      try {
        const r = await postJsonRetry(`${h}/daily-checkin`, headers, {}, 3);
        if (r.status === 401 || r.status === 403) {
          return { result: 'NO_SESSION', report: 'WorkBuddy：登录态已失效，请打开 WorkBuddy 桌面端重新登录（无需改脚本）' };
        }
        if (r.json) {
          const code = r.json.code;
          if (code === 10001) return { result: 'ALREADY', report: 'WorkBuddy：今天已签到，明天再来' };
          // 仅接受明确的成功码；code 缺失时若带了 data 也认（部分接口形态差异），但必须有回查兜底
          if (code === 0 || code === 200 || (code === undefined && r.json.data)) {
            claimed = r.json.data || {};
            break;
          }
          return { result: 'FAIL', report: 'WorkBuddy：领取返回 code=' + code + ' ' + String(r.json.message || '').slice(0, 80) + '（下个补跑时段会重试）' };
        }
        lastErr = `HTTP ${r.status} ${r.text.slice(0, 80)}`;
      } catch (e) {
        lastErr = e.message;
      }
    }

    if (claimed !== null) {
      // 3) 回查状态确认到账（最多查 3 次，每次间隔 2 秒，等服务器落账）
      for (let v = 0; v < 3; v++) {
        await sleep(2000);
        const vs = await wbQueryStatus(headers);
        if (vs.checked === true) {
          const bits = wbDetailBits(claimed);
          const total = (vs.detail && vs.detail.total_credits !== undefined) ? `累计 ${vs.detail.total_credits} 积分` : '';
          if (total && !bits.includes(total)) bits.push(total);
          return { result: 'OK', report: 'WorkBuddy：签到成功' + (bits.length ? '（' + bits.join('，') : '（') + '，已回查确认）' };
        }
        if (vs.checked === false) break; // 状态接口明确说未签 → 跳出回查，进入下一轮领取
      }
      if (round < 1) { await sleep(3000); continue; }
      // 两轮都领了但状态回查不可用：保守标为"未确认"，交给补跑时段幂等重跑
      return { result: 'OK_UNVERIFIED', report: 'WorkBuddy：领取接口返回成功但状态回查未确认，补跑时段会再次核对' };
    }
    if (round === 0) await sleep(15000);
  }
  return { result: 'FAIL', report: 'WorkBuddy：请求失败（' + lastErr + '），今日未完成，下个补跑时段会重试' };
}

/* ==================== TRAE (SOLO CN / Trae CN) ==================== */

const TRAE_API = 'https://api.trae.cn';
const TRAE_VER = '1.107.1';
// iCube 登录态解密常量（与 TRAE 客户端加密格式一致，社区逆向验证）
const HDR_LEN = 6, KEY_LEN = 32, HMAC_LEN = 64;
const URE = Buffer.from([82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37]);
const DRE = Buffer.from([31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125]);

function traeDecrypt(b64) {
  const t = Buffer.from(b64, 'base64');
  const key = t.subarray(HDR_LEN, HDR_LEN + KEY_LEN);
  const sha = crypto.createHash('sha512').update(key).digest();
  const xor = Buffer.alloc(URE.length);
  for (let i = 0; i < URE.length; i++) xor[i] = URE[i] ^ DRE[i];
  const h = crypto.createHash('sha512').update(Buffer.concat([sha, xor])).digest();
  const aesKey = h.subarray(0, 16), iv = h.subarray(16, 32);
  const ct = t.subarray(HDR_LEN + KEY_LEN);
  const d = crypto.createDecipheriv('aes-128-cbc', aesKey, iv);
  const plain = Buffer.concat([d.update(ct), d.final()]); // final() 自动去 PKCS7 padding
  return JSON.parse(plain.subarray(HMAC_LEN).toString('utf8'));
}

function traeAppDirs() {
  const appdata = process.env.APPDATA || '';
  return ['TRAE SOLO CN', 'Trae CN', 'TRAE CN']
    .map(n => path.join(appdata, n))
    .filter(p => fs.existsSync(p));
}

async function traeLoadAuth() {
  const dirs = traeAppDirs();
  if (!dirs.length) return { err: '未找到 TRAE 数据目录（AppData\\Roaming），请确认已安装并登录 TRAE 国内版' };
  // storage.json 同样可能被客户端重写中；改用递增退避（1.5s→3s→5s→8s，约 17 秒窗口）
  const BACKOFF = [1500, 3000, 5000, 8000];
  for (let attempt = 0; attempt <= BACKOFF.length; attempt++) {
    for (const dir of dirs) {
      const sf = path.join(dir, 'User', 'globalStorage', 'storage.json');
      if (!fs.existsSync(sf)) continue;
      try {
        const storage = JSON.parse(fs.readFileSync(sf, 'utf8'));
        const enc = storage['iCubeAuthInfo://icube.cloudide'];
        if (!enc) continue;
        const auth = traeDecrypt(enc);
        if (auth && auth.token) return { auth, dir };
      } catch (e) { /* 下一个目录 */ }
    }
    if (attempt < BACKOFF.length) await sleep(BACKOFF[attempt]);
  }
  return { err: 'TRAE 登录态读取/解密失败（递增退避重试 ' + BACKOFF.length + ' 次），请打开 TRAE 客户端重新登录' };
}

function loadDeviceIdState() {
  try { return JSON.parse(fs.readFileSync(DEV_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveDeviceIdState(s) {
  try { fs.writeFileSync(DEV_FILE, JSON.stringify(s, null, 2), 'utf8'); } catch (e) {}
}
function traeDeviceId(dir, rotate) {
  const st = loadDeviceIdState();
  if (!rotate && st.deviceId) return st.deviceId;
  if (!rotate) {
    // 1) ahanet 配置文件
    try {
      const cfg = fs.readFileSync(path.join(dir, 'ahanet', 'tt_net_config.config'), 'utf8');
      const m = cfg.match(/device_id&#\*(\d+)/);
      if (m) { st.deviceId = m[1]; saveDeviceIdState(st); return m[1]; }
    } catch (e) { /* 下一个 */ }
    // 2) 客户端日志
    try {
      const logsDir = path.join(dir, 'logs');
      const files = fs.readdirSync(logsDir)
        .map(d => path.join(logsDir, d, 'main.log'))
        .filter(p => fs.existsSync(p))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      for (const p of files.slice(0, 5)) {
        const m = fs.readFileSync(p, 'utf8').match(/\[ICDRS\].*?did: (\d+)/);
        if (m) { st.deviceId = m[1]; saveDeviceIdState(st); return m[1]; }
      }
    } catch (e) { /* 兜底 */ }
    // 3) 稳定兜底：按机器特征生成 16 位数字
    if (st.fallbackId) return st.fallbackId;
    const hash = crypto.createHash('sha256').update(require('os').hostname() + process.env.USERNAME + ':trae-checkin').digest('hex');
    st.fallbackId = String(parseInt(hash.slice(0, 13), 16)).padEnd(16, '0').slice(0, 16);
    saveDeviceIdState(st);
    return st.fallbackId;
  }
  // rotate：按时间戳生成新 16 位设备号（9074 时换号重试，社区实测有效）
  const nid = String(Date.now()).slice(-13) + String(process.pid % 1000).padStart(3, '0');
  st.deviceId = nid.slice(0, 16);
  saveDeviceIdState(st);
  return st.deviceId;
}

function traeHeaders(token, deviceId, region) {
  return {
    'Authorization': 'Cloud-IDE-JWT ' + token,
    'X-User-Region': region || 'CN',
    'User-Agent': 'Trae/' + TRAE_VER,
    'Content-Type': 'application/json',
    'x-device-id': deviceId,        // 只发小写一份，大小写同发会被风控判异常
    'x-device-type': 'Windows',
    'x-os-version': '10.0.19045',
    'x-app-version': TRAE_VER,
  };
}

const TRAE_AUTH_FAIL = c => [1001, 1002, 401, 403].includes(c);

async function traeQueryStatus(token, deviceId, region) {
  // 返回 { checked, enable, credits, noSession }
  try {
    const r = await postJsonRetry(`${TRAE_API}/trae/api/v2/ug/checkin_credits/status`, traeHeaders(token, deviceId, region), { req_source: 1 }, 2);
    if (r.json) {
      if (TRAE_AUTH_FAIL(r.json.code) || r.status === 401 || r.status === 403) return { noSession: true };
      if (r.json.code === 0) {
        return {
          checked: !!r.json.checked_in,
          enable: r.json.enable !== false,
          credits: r.json.credits ?? null,
        };
      }
    }
  } catch (e) { /* 查询失败不阻塞 */ }
  return { checked: null, enable: null, credits: null };
}

async function traeCheckin() {
  const a = await traeLoadAuth();
  if (a.err) return { result: 'NO_AUTH', report: 'TRAE：' + a.err };
  const token = a.auth.token;
  const region = (a.auth.userRegion && a.auth.userRegion.region) || 'CN';
  let deviceId = traeDeviceId(a.dir, false);
  const body = { req_source: 1 }; // 空体会被服务端拒成 9074，必须带

  // 1) 查询状态
  const st = await traeQueryStatus(token, deviceId, region);
  if (st.noSession) return { result: 'NO_SESSION', report: 'TRAE：登录态已失效，请打开 TRAE 客户端重新登录（无需改脚本）' };
  if (st.checked === true) {
    return { result: 'ALREADY', report: 'TRAE：今日已签到' + (st.credits !== null ? `（每日活动额度 ${st.credits}，非账户总余额）` : '') };
  }
  if (st.enable === false) {
    return { result: 'INACTIVE', report: 'TRAE：当前账号/时段未开放签到活动' };
  }
  if (STATUS_ONLY) {
    return { result: 'NOT_YET', report: 'TRAE：今日未签到' + (st.credits !== null ? `（每日活动额度 ${st.credits}，待领）` : '，待领取') };
  }

  // 2) 领取 + 回查确认（9074 限流换设备号重试）
  for (let attempt = 0; attempt < 2; attempt++) {
    let r;
    try {
      r = await postJsonRetry(`${TRAE_API}/trae/api/v2/ug/checkin_credits/claim`, traeHeaders(token, deviceId, region), body, 3);
    } catch (e) {
      if (attempt === 0) { await sleep(15000); continue; }
      return { result: 'FAIL', report: 'TRAE：请求失败（' + e.message + '），今日未完成，下个补跑时段会重试' };
    }
    if (r.status === 401 || r.status === 403) {
      return { result: 'NO_SESSION', report: 'TRAE：登录态已失效，请打开 TRAE 客户端重新登录' };
    }
    if (r.json) {
      const code = r.json.code;
      if (code === 0) {
        const pts = (r.json.data && r.json.data.points) || null;
        // 3) 回查确认到账
        for (let v = 0; v < 3; v++) {
          await sleep(2000);
          const vs = await traeQueryStatus(token, deviceId, region);
          if (vs.checked === true) {
            return { result: 'OK', report: 'TRAE：签到成功' + (pts ? `，本次 +${pts} Work 专属积分` : '') + '（已回查确认）' };
          }
          if (vs.checked === false) break;
        }
        return { result: 'OK_UNVERIFIED', report: 'TRAE：领取接口返回成功' + (pts ? `（+${pts}）` : '') + '但状态回查未确认，补跑时段会再次核对' };
      }
      if (code === 9095) return { result: 'ALREADY', report: 'TRAE：今天已签到，明天再来' };
      if (code === 9074 && attempt === 0) {
        deviceId = traeDeviceId(a.dir, true); // 换设备号再试一次
        await sleep(5000);
        continue;
      }
      if (TRAE_AUTH_FAIL(code)) {
        return { result: 'NO_SESSION', report: 'TRAE：登录态已失效（code=' + code + '），请打开 TRAE 客户端重新登录' };
      }
      return { result: 'FAIL', report: 'TRAE：领取返回 code=' + code + ' ' + String(r.json.message || '').slice(0, 80) + '（下个补跑时段会重试）' };
    }
    return { result: 'FAIL', report: 'TRAE：非 JSON 返回 HTTP ' + r.status + '（下个补跑时段会重试）' };
  }
  return { result: 'RETRY_LATER', report: 'TRAE：签到高峰限流（9074），已换号重试仍失败，下个补跑时段会自动补签' };
}

/* ==================== 主流程 ==================== */

(async () => {
  // 隐藏自检模式：发送一条示例成功通知
  if (argMode === 'toast-test') {
    toast('每日积分签到成功 ✅', 'WorkBuddy：签到成功（本次 +100，连续 4 天，已回查确认）；TRAE：签到成功（测试消息）');
    out('NOTIFY | 测试通知已发送');
    process.exit(0);
  }

  // 应急预案 1：真实互联网预检（开机未联网/ Wi-Fi 已连但无网时等待，最长 20 分钟）
  if (!STATUS_ONLY) {
    const online = await ensureOnline();
    if (!online) {
      out('NETWORK | OFFLINE | 20 分钟内未检测到真实互联网，本次放弃（登录/下个时段会自动重试）');
      process.exit(2);
    }
  }

  const summary = {};
  if (!argOnly || argOnly === 'workbuddy') summary.workbuddy = STATUS_ONLY ? await wbStatusLite() : await wbCheckin();
  if (!argOnly || argOnly === 'trae') summary.trae = await traeCheckin();

  for (const [k, v] of Object.entries(summary)) out(`${k.toUpperCase()} | ${v.result} | ${v.report}`);
  const all = Object.values(summary);
  // 完成态：OK/ALREADY/INACTIVE 才算真的不用再管；
  // STATUS（接口不可用）与 NOT_YET（未签）均视为未完成，交给后续重试。
  const done = ['OK', 'OK_UNVERIFIED', 'ALREADY', 'INACTIVE'];
  const bad = all.filter(v => !done.includes(v.result));
  out(`SUMMARY | ${all.map(v => v.result).join(' / ')}${bad.length ? ' ⚠ ' + bad.length + ' 项未完成（补跑时段重试）' : ' ✅'}`);

  // 机器可读结果（供排查/外部工具）
  try { fs.writeFileSync(path.join(BASE, 'last_result.json'), JSON.stringify({ time: ts(), results: summary }, null, 2), 'utf8'); } catch (e) { /* 非关键 */ }

  // ===== 弹窗策略（延迟汇报 + 抗误报）=====
  // 设计目标：只在"真有事"时打扰你一次，其余全静默。
  //   1) 新领取成功 → 立即弹（并标记今日已汇报）
  //   2) 本次只是"已签"，但今天早前成功过且还没汇报过 → 补弹一次（你此刻在用电脑）
  //   3) 登录态失效（NO_AUTH/NO_SESSION）→ 不立即弹！
  //      原因：客户端重写登录态文件会造成瞬时 NO_AUTH，通常下次重试就自愈。
  //      改为连续 2 次不同运行都失败才判定为"真失效"并提醒。
  //   4) 其他失败且已过 18 点 → 提醒
  //   5) 已汇报过 → 彻底静默
  if (!STATUS_ONLY) {
    const newClaims = all.filter(v => ['OK', 'OK_UNVERIFIED'].includes(v.result));
    const authFail = all.filter(v => ['NO_AUTH', 'NO_SESSION'].includes(v.result));
    const today = ts().slice(0, 10);

    let pending = {};
    const PENDING_FILE = path.join(BASE, 'pending_toast.json');
    try { pending = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch (e) { pending = {}; }

    const successReports = all
      .filter(v => ['OK', 'OK_UNVERIFIED', 'ALREADY'].includes(v.result))
      .map(v => v.report);

    if (newClaims.length) {
      // 新领取成功：立即汇报，并标记今日已汇报
      toast('每日积分签到成功 ✅', newClaims.map(v => v.report).join('；').slice(0, 200));
      pending = { date: today, reported: true, reports: successReports, authFailSince: 0, authFailAlerted: false };
      out('NOTIFY | 新领取成功，已即时弹窗');
    } else if (authFail.length) {
      // 登录态读取失败：抗瞬时竞态误报。
      // 判定策略：记录"首次失败时间戳"，只有跨过 AUTH_FAIL_GRACE_MS（默认 30 分钟）
      // 之后仍失败，才判定为真失效并提醒。单纯用"次数"容易被短时间多次运行（手动测试、
      // 网络抖动导致的密集重试）误触发，用时间跨度更稳。
      const now = Date.now();
      if (pending.date !== today || !pending.authFailSince) {
        // 今天首次失败：记录起点，静默
        pending.date = today;
        pending.authFailSince = now;
        out('NOTIFY | 登录态读取失败，记录起点（暂不打扰，30 分钟后仍失败才提醒）');
      } else {
        const elapsedMin = Math.floor((now - pending.authFailSince) / 60000);
        if (elapsedMin >= 30) {
          // 已持续失败超 30 分钟 → 判定真失效（不会自愈）
          if (!pending.authFailAlerted) {
            toast('每日积分签到需要你处理 ⚠', authFail.map(v => v.report).join('；').slice(0, 200));
            pending.authFailAlerted = true;
            out(`NOTIFY | 登录态已连续失败约 ${elapsedMin} 分钟，判定为真失效，已提醒`);
          } else {
            out(`NOTIFY | 登录态仍失效（已 ${elapsedMin} 分钟），今日已提醒过，不再重复`);
          }
        } else {
          out(`NOTIFY | 登录态读取失败（已持续 ${elapsedMin} 分钟），判定为瞬时竞态，暂不打扰`);
        }
      }
    } else if (bad.length === 0 && pending.date === today && !pending.reported && successReports.length) {
      // 关键分支：今天全部领到、但还没向你汇报过 → 现在补弹（你此刻在用电脑）
      // 注意：必须 bad.length === 0（两个平台都搞定）才敢报"已自动领取"，
      // 否则会把"WorkBuddy 成功 + TRAE 失败"误报成全部成功，掩盖真实失败。
      toast('今日积分已自动领取 ✅', successReports.join('；').slice(0, 200));
      pending.reported = true;
      pending.authFailSince = 0;
      pending.authFailAlerted = false;
      out('NOTIFY | 补报今日早前领取成功');
    } else if (bad.length && new Date().getHours() >= 18) {
      // 其他失败：仅在 18 点后仍失败时通知（白天交给后续补跑时段静默重试）
      toast('今日积分签到未完成 ⚠', bad.map(v => v.report).join('；').slice(0, 200));
      out('NOTIFY | 18 点后仍未完成，已提醒');
    } else if (bad.length === 0 && successReports.length) {
      // 全部搞定且已汇报过 → 静默，仅清计数
      pending.date = today;
      pending.authFailSince = 0;
      pending.authFailAlerted = false;
    }

    try { fs.writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2), 'utf8'); } catch (e) { /* 非关键 */ }

    // 结果核对：写入本目录 last_result.json（机器可读）+ signin.log（人可读）
    // 说明：不再在桌面生成便签文件，避免碍眼。需要核对时看日志即可。
  }

  // 退出码：0=全部完成/已签/未开放，2=有未完成项
  process.exit(bad.length ? 2 : 0);
})().catch(e => {
  out('FATAL | ' + e.message);
  process.exit(1);
});

async function wbStatusLite() {
  const t = await wbLoadToken();
  if (t.err) return { result: 'NO_AUTH', report: 'WorkBuddy：' + t.err };
  const headers = {
    'Authorization': 'Bearer ' + t.token,
    'Content-Type': 'application/json',
    'User-Agent': WB_UA,
    'Referer': 'https://www.codebuddy.cn/',
  };
  const st = await wbQueryStatus(headers);
  if (st.checked !== null) {
    // 语义化返回码：已签 → ALREADY（可判为完成）；未签 → NOT_YET（需领取）
    return {
      result: st.checked ? 'ALREADY' : 'NOT_YET',
      report: 'WorkBuddy：今日' + (st.checked ? '已签到' : '未签到') +
        (st.detail && st.detail.total_credits !== undefined ? `（累计 ${st.detail.total_credits} 积分）` : ''),
    };
  }
  // 状态接口不可用：无法判断，返回 STATUS 交由调用方保守处理
  return { result: 'STATUS', report: 'WorkBuddy：状态接口暂不可用（领取接口不受影响）' };
}
