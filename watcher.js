'use strict';
/*
 * watcher.js — 每日积分签到常驻监控（跑完即退，极低占用）  [wb-trae-checkin v1.3.1]
 *
 * 定位：调度层的最后一道兜底。即使所有计划任务触发都被系统吞掉，
 *       只要电脑开着且联网，watcher 也会在几分钟内把当天积分领到。
 *
 * 设计：
 *   - 开机/登录后由计划任务 DailyCreditWatcher 拉起，进入"看门狗"循环
 *   - 每 POLL_MS（默认 3 分钟）醒一次，按成本从低到高依次判断：
 *       1) 读 last_result.json 判断"今天是否已全部搞定"（纯文件读，不联网，零成本）
 *       2) 未搞定 → 调 checkin.js status 问服务器要权威答案（轻量，不消耗领取次数）
 *       3) 服务器也说没签 → 调 checkin.js silent 真正领取
 *   - 任一环节确认"今天已签完" → 立即 break 退出（进程消失，0 占用）
 *   - 安全阀：最长存活 MAX_LIFE_H（默认 20 小时）后强制退出，避免永久驻留
 *
 * 性能：
 *   - 每次循环只读 1 个小 JSON 文件 + sleep（Atomics.wait 阻塞，不空转）
 *   - 仅"未完成"时才启动子进程，正常一天只触发几次
 *   - 完成即退，不会长期挂在后台
 *
 * 用法： node watcher.js [--once]
 *   --once  只检查一轮就退出（用于测试）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BASE = __dirname;
const NODE = process.env.CHECKIN_NODE || process.execPath;
const SCRIPT = path.join(BASE, 'checkin.js');
const RESULT = path.join(BASE, 'last_result.json');
const LOG = path.join(BASE, 'watcher.log');
const PIDF = path.join(BASE, 'watcher.pid');

const POLL_MS = Number(process.env.WATCHER_POLL_MS || 3 * 60 * 1000);   // 3 分钟
const MAX_LIFE_H = Number(process.env.WATCHER_MAX_LIFE_H || 20);        // 20 小时
const ONCE = process.argv.includes('--once');

const DONE = ['OK', 'OK_UNVERIFIED', 'ALREADY', 'INACTIVE'];

function log(line) {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const t = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  try { fs.appendFileSync(LOG, `[${t}] ${line}\n`, 'utf8'); } catch (e) { /* 忽略 */ }
}
function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function sleepSync(ms) {
  // 同步 sleep，避免事件循环空转占用
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/* 单实例保护：已有存活 watcher 则直接退出 */
function guardSingle() {
  try {
    if (fs.existsSync(PIDF)) {
      const old = parseInt(fs.readFileSync(PIDF, 'utf8').trim(), 10);
      if (old && old !== process.pid) {
        try {
          process.kill(old, 0);          // 探测旧进程是否还活着
          log(`已有 watcher 存活 (pid=${old})，本次退出`);
          process.exit(0);
        } catch (e) { /* 旧进程已死，继续 */ }
      }
    }
    fs.writeFileSync(PIDF, String(process.pid), 'utf8');
  } catch (e) { /* 忽略 */ }
}

/* 纯文件读取：今天的签到是否已全部完成（不联网、极快） */
function todayAllDone() {
  try {
    const j = JSON.parse(fs.readFileSync(RESULT, 'utf8'));
    if (!j) return false;
    if (String(j.time).slice(0, 10) !== today()) return false;
    const rs = Object.values(j.results || {});
    if (!rs.length) return false;
    return rs.every(v => DONE.includes(v.result));
  } catch (e) { return false; }
}

/**
 * 权威判据：直接问服务器"今天签了吗"（轻量查询，不消耗领取次数）。
 * 用于 last_result 不可信的场景——典型是 WorkBuddy 客户端正重写登录态文件时
 * 读到 NO_AUTH，但服务器端其实早已签到。此时若盲目重试只会空转。
 *
 * 返回 true = 服务器端两平台均已签（可安全收工）
 * 返回 false = 有平台确实未签，或无法确认（调用方继续走签到流程，幂等安全）
 */
function serverSaysDone() {
  try {
    spawnSync(NODE, [SCRIPT, 'status'], { cwd: BASE, timeout: 90 * 1000, encoding: 'utf8' });
    // status 模式同样会刷新 last_result.json；读取结果做权威判断
    let j;
    try { j = JSON.parse(fs.readFileSync(RESULT, 'utf8')); } catch (e) { return false; }
    const rs = Object.values(j.results || {});
    if (!rs.length) return false;
    // status 模式下语义化返回码：已签 → ALREADY / OK；未签 → NOT_YET / NO_AUTH / RETRY_LATER
    const DONE_SERVER = ['OK', 'OK_UNVERIFIED', 'ALREADY', 'INACTIVE'];
    const allDone = rs.every(v => DONE_SERVER.includes(v.result));
    if (allDone && String(j.time).slice(0, 10) === today()) {
      log(`  · 服务器确认：${rs.map(v => v.result).join(' / ')}`);
      return true;
    }
    return false;
  } catch (e) { return false; }
}

/* 跑一次签到（silent，不重复弹窗——弹窗由 checkin.js 内部按策略处理） */
function runCheckin() {
  const r = spawnSync(NODE, [SCRIPT, 'silent'], { cwd: BASE, timeout: 25 * 60 * 1000 });
  return r.status;
}

function main() {
  guardSingle();
  process.on('exit', () => { try { fs.unlinkSync(PIDF); } catch (e) {} });
  log(`watcher 启动 pid=${process.pid} poll=${POLL_MS / 1000}s maxLife=${MAX_LIFE_H}h`);

  const started = Date.now();
  let rounds = 0;

  while (true) {
    rounds++;

    // 1) 先看文件：今天是否已完成（零成本）
    if (todayAllDone()) {
      log(`第 ${rounds} 轮：今日已全部完成，watcher 退出`);
      break;
    }

    // 2) 文件说未完成 —— 但可能不可信（如登录态文件竞态导致的 NO_AUTH 假阴性，
    //    或 last_result.json 还停留在昨天）。先问服务器要权威答案；
    //    服务端确认已签则直接收工，避免空转重试。
    if (serverSaysDone()) {
      log(`第 ${rounds} 轮：服务器确认今日已签到，watcher 退出（本地文件状态可能滞后）`);
      break;
    }

    // 3) 服务器也确认未签 → 真正执行签到（内含真实联网探测 + 等网 20 分钟）
    log(`第 ${rounds} 轮：今日尚未完成，执行签到…`);
    const code = runCheckin();

    // 4) 复查
    if (todayAllDone()) {
      log(`第 ${rounds} 轮：签到完成（exit=${code}），watcher 退出`);
      break;
    }
    log(`第 ${rounds} 轮：仍未完成（exit=${code}），${POLL_MS / 60000} 分钟后重试`);

    if (ONCE) break;

    // 5) 安全阀
    if (Date.now() - started >= MAX_LIFE_H * 3600 * 1000) {
      log(`已达最长存活 ${MAX_LIFE_H}h，watcher 退出（交给下个时段/下次登录）`);
      break;
    }

    // 6) 睡一会儿再看
    sleepSync(POLL_MS);
  }

  try { fs.unlinkSync(PIDF); } catch (e) {}
}

main();
