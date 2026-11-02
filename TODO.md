# 先声（Warnfirst）TODO

项目 2026-10-29 由 `first-sight` 更名为 `warnfirst`／先声。更新：2026-11-02。

维护规则：每次任务结束前核对本文件，完成项写明文件与验证结果；**部分完成不得勾选整个阶段**；失败的试验保留记录，不删。

---

## 本线方向（2026-11-02 确定）

**单一语音通道下的安全调度**：多条候选语句抢一条声道时，谁先说、要不要打断、被打断的怎么续；危险预警是硬约束而非加权项。配套的是危险检测链路，以及能把策略差异量出来的评测口径。

不属于本线的方向（区域分割、三视图身份、边界组、头盔采集、空间记忆评测）已于 2026-11-02 移出仓库，见下方清洗记录。

---

## 一、语音链路（未闭环）

### 1.1 已修但未在手机上验证

- [x] **TTS 流式 WAV 头**：qwen3-tts 返回的 RIFF/data 长度是占位值（实测声明约 2 GB），浏览器 `decodeAudioData` 解码失败导致完全无声，而服务端一路 200。`src/trial-server.ts` 的 `repairWavSizes()` 重写两个字段（实测 RIFF=65,316、data=65,280，与文件长度一致）。提交 `ff1fd1e`。
- [ ] 修好后手机是否真的出声：未验证。
- [x] **回答从不播报的根因**：`request-agent.ts` 把本次回答写入服务端 `state.lastAnswer`，客户端又用它覆盖本地比较基准，导致 `isSameAnswer(x, x)` 恒为 true，每句都被判重复而跳过。改为客户端自有的 `lastShownAnswer`。
- [ ] 刷新页面 → 重新输口令 → 说一句 → 读 `run/client-log.jsonl`，确认是 `speak_skip`、`arbiter_*` 还是 `tts_error`：未验证。

### 1.2 客户端打断

- [x] 打断计时改到音频真正开始（`beginPlayback()`），此前把等 `/api/tts` 的时间算作播放时间，导致一出声就自我打断。
- [x] `AudioContext` 挂起先 `resume()`，仍不可用退回 `<audio>` 元素。
- [x] 每句 20 秒看门狗：任何一句卡住都会让后续全部排队。
- [x] 打断阈值按每句实测回声基线 ×1.6 自适应（上限 0.30），不用固定 0.10。
- [x] 安全预警不被用户说话打断：截断「停下，前面有台…」本身就是伤害。
- [ ] 以上改动均在真机上复测确认。

### 1.3 观测设施

- [x] `run/voice-log.jsonl`：每次 TTS 合成的 `ok / bytes / headerRepaired / error`。
- [x] `run/client-log.jsonl` + `/api/client-log`：`answer(shouldSpeak, repeated)`、`speak_skip`、`speak_queue`、`speak_start`、`arbiter_call/decision/held/error`、`tts_ok/error`。
- [x] 页面「🔍 语音自检」按钮：构建号、开关、`AudioContext` 状态、`/api/tts` 耗时与字节数。

---

## 二、安全线（硬约束）

职责是充当用户的眼睛，首要目标是不让人受伤；因此安全预警是硬约束而不是可加权的软目标。

- [x] 危险检测可离线复验：`/api/hazard` 的模型调用抽成 `src/agent/hazard-check.ts`，在线与离线共用；`src/agent/hazard-replay.ts` 扫描 `run/mobile-staging` 的每个暂存目录（一次观察），按人工标注打分；`src/sim/hazard-replay.ts` 为 CLI。
- [x] 离线回放的失败语义：请求失败、回复不可解析记为 error 而不是 clear；`results.jsonl` 的 `humanLabel` 留给人工填写，`--labels` 才计算漏报／误报，未标注单独计数不折算分数。
- [x] 仲裁的重复抑制分层：`latchKey` 按 3 秒提醒间隔放开；相同文本 15 秒内不重复；**安全行不再受按类型的 1.5 秒冷却约束**（该冷却会把两条不同的危险里后一条静默丢弃）。提交 `6203e02`。
- [x] 计数自洽校验：`spoken + neverSpoken == arrivals` 不成立时 `simulatePolicy` 直接抛错。
- [ ] **真机一次连续行走的漏报检查**：需要 `QWEN_API_KEY`，按 `--limit` 控制付费调用次数；重点看漏报（标为危险却判定安全），不是误报。目前误报／漏报数据仍为 **0**，未拿到人工标注，不能说安全能力已验收。
- [ ] 危险候选的 `latchKey` 在生产链路里是否真的被赋值：`events.jsonl` 里现有记录的 `latchKey` 全为 undefined，说明去重实际走的是文本窗口，需要核实。

---

## 三、评测口径（本线自有）

- [x] `sim:arbiter`：单条轨迹反事实回放，两套策略对比，输出 `comparison.json` + `report.md`。
- [x] `sim:arbiter:sweep`：泊松到达的工作量模型，27 格 × 24 种子 × 3 策略，输出扫描表与帕累托前沿，带种子可复现。
- [x] 指标分离：`safetyLost`（不含去重）与 `safetyLostStrict`（无理由去重也计入）并列输出。
- [x] 消融保留：旧行为作为 `safety-first-oldcooldown` 留在扫描里，不因改动而消失。
- [ ] 工作量模型的到达率与回答长度用真实日志拟合（现在只有 7 次 `arbiter_decision`，样本不足）。
- [ ] 加入中间策略（安全行限长压缩、长回答摘要后续播），让帕累托前沿不只有两个端点。

---

## 四、2026-11-02 清洗记录

删除的是**研究方向**，不是同源代码。共移除 78 + 14 个 TypeScript 文件、`sim/` 下全部 Python 仿真脚本、`docs/research/`、`docs/experiments/`、`docs/archive/`、`docs/references/`，并裁掉 `package.json` 中 13 个指向它们的 script。

保留 `agent/place-memory.ts` 与 `agent/place-candidates.ts`：它们是 `scene-agent` 的场景记忆依赖，属于产品功能，不属于那条研究线。对应测试改为 `npm run test:place`。

删除依据是依赖图：从产品入口做传递闭包，只有这两个空间记忆文件可达；其余 78 个文件仅被测试和评测 CLI 引用，而 24 个 `src/sim/*.ts` 是纯命令行脚本。

清洗后 `npm run build` 通过，`npm run test:hazard` 37/37、`npm run test:place` 通过。

未做：`git` 历史里的旧提交仍在，与同源仓库的历史不可切断；如需彻底剥离需重写历史，暂不做。

---

## 五、当前运行状态

试用服务通常以隐藏进程运行（`node dist/trial-server.js`，口令 `zpf`，监听 8765/8767）。改了服务端代码必须重新 `npm run build` 并重启；只改 `web/` 刷新页面即可。

手动重启：

```powershell
$env:VLM_TRIAL_PASSCODE="zpf"; npm.cmd run trial:web
```
