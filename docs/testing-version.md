# v1.1.0-test.4：语音通道与安全线测试版

日期：2026-10-12 首次冻结，2026-11-02 按新方向重写范围。**这是研究测试快照，不是可靠性验收通过。**

## 本版范围

本线只做一件事：**单一语音通道下的安全调度**，以及支撑它的危险检测链路。

- 语音通道：`src/agent/response-arbiter.ts`。优先级 `safety < clarify < task < ambient`；抢占只在更急的类型对更缓的类型时发生；被打断的语句未过期则回队列。
- 重复抑制分层：`latchKey` 按 3 秒提醒间隔放开；相同文本 15 秒内不重复；安全行**不受**按类型的 1.5 秒冷却约束。
- 危险链路：`src/agent/hazard-check.ts`（在线与离线共用一份实现）→ `/api/hazard` → `safety` 候选；`src/agent/hazard-replay.ts` 按人工标注回放。
- 评测：`sim:arbiter`（单轨迹反事实回放）、`sim:arbiter:sweep`（工作量扫描）。计数不自洽时直接抛错。

## 不做什么

区域分割、边界组、三视图身份匹配、头盔采集、空间记忆评测**不做**，相关代码与文档已于 2026-11-02 移出。`place-memory` / `place-candidates` 保留，仅作为 `scene-agent` 的地点标签功能，不产生研究结论。

## 已验证与未验证

已验证：

- `npm.cmd run build` 通过。
- `npm.cmd run test:hazard` 37/37 通过（含两条新增回归：不同危险不被同类冷却吞掉、相同文本仍在窗口内被抑制）。
- `npm.cmd run test:place` 通过。
- `sim:arbiter` 在构造场景与 3 个真实会话上可跑通，输出 `comparison.json` + `report.md`。
- `sim:arbiter:sweep` 在 27 格 × 24 种子 × 3 策略下可复现：`safety-first` 安全行严格丢失 0/27 格，`fifo` 27/27 格均有丢失（7.7%–36.4%）。

未验证：

- 手机端是否真的出声（WAV 头修复后未真机复测）。
- 危险提示在真机上的漏报率与误报率：**0 个数据点**，没有人工标注。
- 工作量扫描的到达率是假设值（泊松），不是从真实日志拟合而来。
- 付费模型调用不在回归套件内。

## 检查入口

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run test:hazard
npm.cmd run test:place
npm.cmd run sim:arbiter -- --scenario hazard-mid-answer
npm.cmd run sim:arbiter -- --session all
npm.cmd run sim:arbiter:sweep
```

这些是软件机制回归，不是安全能力认证。`run/` 数据不随版本发布。
