# wb-trae-checkin

> 让 WorkBuddy 和 TRAE（国内版）的每日签到积分**自动到账**，装一次，之后不用管。

Windows 计划任务 + 常驻看门狗双保险，静默执行、零依赖、不弹窗打扰你。专门解决"签到断一天就白丢"的问题。

<p>
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows-0078D6">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D18-339933">
  <img alt="deps" src="https://img.shields.io/badge/dependencies-0-brightgreen">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
</p>

**支持的平台**

| 平台 | 版本 | 支持情况 |
|---|---|---|
| WorkBuddy | 桌面客户端 | ✅ 支持 |
| TRAE | 国内版（Trae CN / TRAE SOLO CN） | ✅ 支持 |
| TRAE | 国际版 | ➖ 不需要（额度自动发放，无签到） |

> 非官方工具，仅供个人学习交流。接口与凭证解密方式均来自社区实测与逆向，可能随官方调整失效——但失效时你会在日志里看到明确的失败原因，不会静默漏签。

---

## 目录

- [它是怎么做到"漏不掉"的](#它是怎么做到漏不掉的)
- [快速开始](#快速开始)
- [怎么确认它真的在工作](#怎么确认它真的在工作)
- [每天能领多少](#每天能领多少)
- [常见问题](#常见问题)
- [工作原理](#工作原理)
- [安全与隐私](#安全与隐私)
- [文件说明](#文件说明)
- [已知限制](#已知限制)

---

## 它是怎么做到"漏不掉"的

普通的定时任务怕两种情况：**系统把任务吞了**、**执行时刚好没网**。这个项目用三层保险来对付：

| 层 | 组件 | 兜住什么情况 |
|---|---|---|
| ① 定时触发 | `DailyCreditCheckin` 计划任务 | 每天 4 个固定时段（00:05 / 09:00 / 12:30 / 19:00）**+ 每小时兜底 + 每次开机登录后 30 秒** |
| ② 常驻看门狗 | `DailyCreditWatcher` 计划任务 → `watcher.js` | 开机后驻留，每 3 分钟瞄一眼，**今天签完立即退出**；就算所有定时触发都被系统吞掉，它也能补上 |
| ③ 脚本内部 | `checkin.js` | 真实联网探测、失败重试、**领取后回查服务器确认到账**、登录态竞态退避 |

三层互补，任一层漏掉都有其他层兜住。

**其他值得一提的细节**

- **零依赖**：核心就是一个 Node.js 脚本（Node >= 18），不需要 `npm install`
- **不需要打开客户端**：直接调官方接口，客户端开不开都行
- **幂等安全**：已签自动跳过，重复执行不会多领（脚本级幂等，不是靠时间去赌）
- **真实联网才执行**：Windows 的"网卡已连接"不可信（虚拟网卡 / 网页认证劫持都会误判）。脚本用 Windows 同款 NCSI 内容校验 + API 真实应答双重探测，真断网就等（最长 20 分钟），等不到就静默交给下个时段——**不会误报，也不会白耗**
- **登录态竞态自动重试**：客户端会周期性重写凭证文件，脚本用递增退避（1.5→3→5→8→12 秒）跨越写入期
- **限流自动换号重试**：TRAE 返回 9074 时自动更换设备号重试
- **通知不骚扰你**：新领到积分时立即弹一次；若成功发生在你不在电脑前（如零点补跑），会在你登录用电脑时补弹；登录态失效要**持续 30 分钟**才判定为真失效并提醒（单次失败是文件写入竞态，静默）。同一天不重复打扰。设 `CHECKIN_NOTIFY=0` 可彻底关闭通知

---

## 快速开始

**1. 装 Node.js**（已装可跳过）

到 <https://nodejs.org/> 下载 LTS 版，一路下一步即可。

**2. 登录两个客户端**

确保本机 **WorkBuddy**、**TRAE 国内版** 至少登录过一次。（登录过就行，之后不用再开。）

**3. 双击 `install.bat`**

安装器会检查环境、注册任务、并立即试跑一次。看到两行 `[OK]` 就装好了：

```
=== wb-trae-checkin installer v1.3.1 ===
[OK] Node.js found: C:\Program Files\nodejs\node.exe (v22.x)
[OK] Silent launcher written: ...\run_checkin.vbs
[OK] Watcher launcher written: ...\run_watcher.vbs
[OK] Task 'DailyCreditCheckin' registered:
     Triggers: daily 00:05 / 09:00 / 12:30 / 19:00 + hourly safety net + every logon
     Invisible (no window). Catch-up enabled for missed slots.
[OK] Task 'DailyCreditWatcher' registered (logon + daily 08:00)

[..] Running a one-time test check-in (about 20 seconds)...
----- signin.log (last 4 lines) -----
[2026-10-11 02:38:28] WORKBUDDY | OK | WorkBuddy：签到成功（连续 7 天，累计 700 积分，已回查确认）
[2026-10-11 02:38:28] TRAE | OK | TRAE：签到成功（已回查确认）
[2026-10-11 02:38:28] SUMMARY | OK / OK ✅
-------------------------------------

[DONE] If both platforms show OK / ALREADY above, setup is complete.
```

> 若提示 `[X] Node.js not found`，说明还没装 Node.js——装完 LTS 版再跑一次即可。

---

## 怎么确认它真的在工作

**最直接：看日志**

打开本目录下的 `signin.log`，每次执行都会追加一行。正常的样子：

```
[2026-10-11 00:05:07] WORKBUDDY | OK | WorkBuddy：签到成功（连续 7 天，累计 700 积分，已回查确认）
[2026-10-11 00:05:07] TRAE | OK | TRAE：签到成功（已回查确认）
[2026-10-11 00:05:07] SUMMARY | OK / OK ✅
```

**手动查当前状态**（只查询，不领取）：

```bash
node checkin.js status
```

**手动补签**（幂等，已签会自动跳过）：

```bash
node checkin.js auto
```

**结果码含义**

| 码 | 含义 | 要处理吗 |
|---|---|---|
| `OK` | 签到成功，且已回查确认到账 | 不用 |
| `OK_UNVERIFIED` | 接口说成功，但回查没确认到 | 不用，下个时段会自动核对 |
| `ALREADY` | 今天已签过 | 不用 |
| `INACTIVE` | 当前账号/时段未开放活动 | 不用 |
| `NO_SESSION` | **登录态失效** | 要，打开客户端重登一次 |
| `FAIL` / `NOT_YET` | 本次失败，下个时段会重试 | 一般不用，持续失败会收到通知 |

---

## 每天能领多少

> **数据来源**：下表数值来自**本机账号接口实测**（2026-10-11 核对）。签到是**限时活动**，期次和额度可能随时调整，**以客户端实际显示为准**。

| 平台 | 每天 | 备注 |
|---|---|---|
| WorkBuddy | **100 积分** | 活动名"Buddy加油站"，当前第 10 季（2026-09-30 ~ 10-15） |
| TRAE（国内版） | **100 Work 专属积分** | 接口返回的每日活动额度 |

> ⚠️ 网上流传"连续签到第 7 天送 1000 积分"的说法，**经本机账号接口实测证伪**（连签满 7 天后累计仅 700 分，`streak_bonus_credit` 为 0）。那类文章多为过时信息或互相转载，请勿采信。

---

## 常见问题

<details>
<summary><b>电脑一直开着不关机，第二天还会签到吗？</b></summary>

会。定时触发器按系统时钟正常打点；另有"每小时兜底"触发器和常驻看门狗兜底。**不依赖关机/唤醒事件**。
</details>

<details>
<summary><b>需要每天打开 WorkBuddy / TRAE 吗？</b></summary>

不需要。脚本用的是登录时保存的凭证，客户端不用开。

只有当凭证过期时（长时间完全不开客户端），才需要打开客户端重新登录一次。届时你会持续收到失败提醒，按提示操作即可。
</details>

<details>
<summary><b>开机时没联网 / 网卡连着但实际没网怎么办？</b></summary>

三重保障：① 每次登录后 30 秒自动触发一次；② 每小时兜底 + 常驻看门狗持续盯着；③ 脚本内用 NCSI 内容校验 + API 真实应答探测"真实互联网"，确认没网会等 20 分钟，等不到就静默交给下个时段。

> 安装时**故意不设置** Windows 的"仅网络可用时启动"——该判断在虚拟网卡 / VPN / 休眠唤醒后经常误判，而且被它拦下的任务**不会被"错过补跑"机制救回**，会导致整天漏签。
</details>

<details>
<summary><b>会占性能吗？</b></summary>

几乎不占。签到主任务每次运行几秒到几十秒就退出。看门狗平时每 3 分钟只读一个小 JSON 文件（阻塞式 sleep，CPU≈0%），**当天签完立即退出**，不会长期驻留内存。
</details>

<details>
<summary><b>支持多账号吗？</b></summary>

TRAE 会自动扫描本机多个客户端目录（SOLO CN / Trae CN）并去重；WorkBuddy 取当前登录的账号。
</details>

<details>
<summary><b>怎么卸载？怎么彻底清理？</b></summary>

双击 `uninstall.bat`，会同时移除签到任务与看门狗任务。

想彻底清理，再手动删掉本目录即可（`signin.log`、`watcher.log`、`*.json` 等都是本地数据文件，不含凭证）。
</details>

<details>
<summary><b>以后这个项目更新了，我怎么升级？</b></summary>

重新 `git pull`（或重新下载），再双击一次 `install.bat` 即可——安装器用 `-Force` 覆盖注册，**重复安装是安全的**，不会产生重复任务。

你的登录态、日志、设备号都在本地，升级不会丢。
</details>

<details>
<summary><b>会不会把我的账号弄封？</b></summary>

脚本只做两件事：读取本机凭证、调用官方签到接口——**和你在客户端里手点签到是完全相同的请求**，只是代替你点了那一下。没有模拟鼠标、没有刷量、没有多开账号。

但请自行评估风险并遵守各平台服务条款。
</details>

---

## 工作原理

1. **读取本机登录凭证**（全程不出本机）
   - WorkBuddy：明文 JSON
   - TRAE：AES 加密的 `storage.json`，脚本在本地解密
2. **调用官方签到接口**
   - WorkBuddy：`POST /v2/billing/meter/daily-checkin`
   - TRAE：`POST /trae/api/v2/ug/checkin_credits/claim`
3. **回查状态接口**确认已签到后，写入 `signin.log`

---

## 安全与隐私

- 仓库**不含任何密钥**；所有凭证都在你自己的电脑上读取和使用
- 需要读取本机凭证文件——这是签到接口鉴权的唯一方式。**代码是明文的，你可以自己审一遍**（`checkin.js` 是单文件，无压缩无混淆）
- 日志**不打印 token**
- ⚠️ **不要**把你的 `signin.log`、`trae_device_id.json` 或任何登录态文件提交到公开仓库（`.gitignore` 已默认排除这些）
- 本项目与腾讯、字节跳动**无任何隶属关系**；使用风险自负

---

## 文件说明

| 文件 | 作用 |
|---|---|
| `checkin.js` | 核心签到脚本（Node >= 18，零依赖，单文件） |
| `watcher.js` | 常驻看门狗（签完即退，极低占用） |
| `install.bat` / `install.ps1` | 一键安装（注册两个计划任务 + 试跑） |
| `uninstall.bat` / `uninstall.ps1` | 一键卸载 |
| `signin.log` / `watcher.log` | 运行后自动产生，可查看每次执行结果 |
| `last_result.json` | 最近一次执行的机器可读结果（供排查 / 二次开发） |

> `run_checkin.vbs` / `run_watcher.vbs` 由安装器自动生成（用于静默启动，不弹黑窗），不在仓库中。

---

## 已知限制

- **仅 Windows**：依赖计划任务（Task Scheduler）。macOS / Linux 需要自行改写调度层（核心 `checkin.js` 逻辑可复用）。
- **依赖登录态**：凭证过期需要你手动重登一次客户端。
- **接口可能失效**：签到是官方限时活动，活动结束或接口调整时工具会失效；届时失败原因会写在日志里。
- **TRAE 国际版不适用**：国际版额度自动发放，无签到。

---

## License

[MIT](LICENSE)
