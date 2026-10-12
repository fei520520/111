# 2026-10-12 手机端交互改造记录

本文件记录本轮针对手机端「实时性 / 交互性 / 低调用」的应用层改动，供下次接着做。

> 说明：`web/app.js` 是静态文件，**手机刷新页面即生效，无需重启服务**；服务端改动（`src/trial-server.ts` 的 `/api/asr`、`/api/tts`）需要 `npm run build` 后重启。

## 一、本轮解决的问题

用户在使用中提出四个真实痛点，均已改动：

| # | 问题 | 位置 | 处理 |
|---|---|---|---|
| 1 | 播报时听不到用户说话，必须等它念完 | `web/app.js` | 全双工打断：播报时仍监听，用户持续说话即 `stopSpeaking()` 并转去听 |
| 2 | 语速太慢、音色不够甜 | `web/app.js` | `SPEECH_RATE=1.25`（同时提速+提音调）、`SPEECH_PITCH=1.3`；服务端音色候选见下 |
| 3 | 找到东西后不能及时更正（等播报完才更新） | `web/app.js` | 播报优先级 `SPEECH_LOW/NORMAL/URGENT`，高优先级打断自己并清空队列；重复答案不重复播报 |
| 4 | 行进中场景滞后 | `web/app.js` | 自动观察间隔 10s→3.5s；轮询 5s→2.5s；上传帧窗口 8s→3.5s |
| 5 | **API 调用太高** | `web/app.js` | 「找东西」由固定轮询改为**变化驱动**：画面没变则跳过调用 |

## 二、关键实现点

### 全双工打断（barge-in）
- `vadTick()` 播报期间不再 `return`，改用更高阈值 `BARGE_IN_THRESHOLD = 0.10`（正常 VAD 阈值 0.045）
  且需连续 `BARGE_IN_STREAK = 4` 次（≈360ms）才判定为用户插话，避免把自己的声音当用户
- `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`
- 仍存在的风险：**回声消除效果取决于手机机型**，可能误打断或误识别

### 播报优先级
```js
const SPEECH_LOW = 0;      // 背景叙述：正在说话时直接丢弃
const SPEECH_NORMAL = 1;   // 状态与回复：可打断旧内容
const SPEECH_URGENT = 2;   // 用户正在找的东西的答案
```
`showRequestResult()` 使用 `SPEECH_URGENT`，并用 `isSameAnswer()`（字符 2-gram 重叠 ≥0.7）判断是否实质重复。

### 变化驱动的调用控制
```js
const REQUEST_CHANGE_DELTA = 0.06;   // 画面变化低于此值不调用
const REQUEST_IDLE_MAX_MS = 20_000;  // 静止时的兜底间隔
```
`stepRequest()` 比较当前帧签名与上次调用时的签名（`state.request.lastStepSignature`）。
诊断区显示 `找东西：模型调用 N 次 · 省下 M 次（X% 未调用）`。

## 三、待办与未决问题

- [ ] **音色未定**：候选样本在 `run/tts-samples/`（Cherry / Serena / Chelsie / Jada / Jennifer），
      选定后设 `QWEN_TTS_VOICE=<名字>` 并重启服务。当前默认 `Cherry`。
- [ ] **`ROUTER_MIN_INTERVAL_MS` 取值未定**：现为 3.5s（原 10s）。自动观察本身是变化驱动的，
      该值只是上限；若要更省可回退到 10s。
- [ ] **端侧快速判断未做**：目前"发现了"仍需等一次 VLM 调用（2–3s）。
      若要压到 1s 内，需要本地先出声、模型结果到达后再修正。
- [ ] **真机验证未完成**：打断是否生效、是否误打断、语速是否合适，均需在手机上实测。
- [ ] **服务端 TTS 不支持语速参数**（`qwen3-tts-flash` 只有 `text`/`voice`/`language_type`），
      故语速靠播放速率实现；`qwen3-tts-instruct-flash`（可用自然语言控制语气）该平台**不存在**。

## 四、下次的起点（按优先级）

1. **手机实测**本轮 5 项改动，收集"打断是否生效 / 是否误打断 / 语速是否合适"
2. **确定音色**（听 `run/tts-samples/` 后设环境变量）
3. **把"调用决策"做成可测实验**：跑出「调用率 vs 发现延迟」的 Pareto 曲线
4. 考虑把 `observe`（再调一次模型）并入 `docs/research/clarifying-dialogue.md` 的 POMDP 动作空间，
   使「何时看」与「何时问」统一到同一框架
