# 先声 Warnfirst · 安全优先的第一视角语音助理

**当前快照：v1.1.0-test.4 · 研究测试版**（2026-11-02）

一个手机浏览器里的第一视角助理：手机摄像头连续取景，服务端用 Qwen 多模态模型理解画面，输出**只有一条语音通道**。本线研究的不是「能不能看懂画面」，而是**「该先说哪句、什么时候必须打断」**——一条声道里同时有危险预警、场景变化、用户提问时，谁先说、谁让位、被打断的怎么续。

本线的硬约束：**安全优先不是加权项**。危险判断不参与打分排序，宁可让用户先停下等确认，也不冒险推进；宁可误报，也不漏报。

> 说明：仓库里 `place-memory` / `place-candidates` 是为「场景/地点」这一条观察线服务的基础实现，本线不对区域分割、三视图身份、空间记忆做任何研究声称，也不保留相关评测口径。历史文档已随上一轮清洗移出。

---

## 1. 使用说明（iOS / Android）

完整步骤见 [docs/application/mobile-trial.md](docs/application/mobile-trial.md)。

### 1.1 前置

- Windows 电脑 + 同一 Wi-Fi 下的手机（iPhone 或 Android）。
- Node.js ≥ 20；Python 3 + OpenCV（图片记忆用，见 `requirements.txt`）。
- 服务端环境变量：`QWEN_API_KEY`、`QWEN_BASE_URL`，可选 `QWEN_MODEL`（默认 `qwen3-vl-plus`）。

### 1.2 电脑端准备

```powershell
npm.cmd install
python -m pip install -r requirements.txt          # 建议装在 .venv 里
powershell -ExecutionPolicy Bypass -File scripts/setup-lan-tls.ps1
```

### 1.3 启动服务

```powershell
$env:VLM_TRIAL_PASSCODE = "zpf"      # 至少 3 位的临时口令
npm.cmd run trial:web
```

终端会打印网页地址 `https://<LAN-IP>:8765/vlm` 与 CA 安装页 `http://<LAN-IP>:8767/`。

### 1.4 手机安装并信任 CA

- **iOS**：Safari 打开 `http://<LAN-IP>:8767/` 下载证书 → 设置里安装描述文件 → 证书信任设置里开启完全信任。
- **Android**：Chrome 打开同一地址 → 设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书。

不信任 CA 时浏览器会拦截 HTTPS；换 IP 后需重装。

### 1.5 打开试用页

手机浏览器打开 `https://<LAN-IP>:8765/vlm`，输入口令登录，点「开启摄像头」。iOS 还需允许「运动与方向」权限。

页面三条线：**场景**（当前地点 / 新场景 / 回到已知场景）、**场景变化**（同一地点内的非位移变化）、**用户要求**（提问 / 目标 / 关注条件）。语音输入与语音播报均已接入。

### 1.6 其他入口

| 入口 | 用途 |
|---|---|
| `/vlm` | 主试用页 |
| `/vio` | VIO 探针，采集灰度帧 + IMU |
| `/report` | 离线运动轨迹报告列表 |
| `npm.cmd run vio:plot` / `motion:plot` | 生成轨迹报告 |

### 1.7 常见问题

- **证书不受信任**：回到 1.4 第 3 步。
- **没有运动数据**：确认已允许「运动与方向」。
- **`/api/...` 503**：服务端未配置 `QWEN_API_KEY` / `QWEN_BASE_URL`。
- **`/api/...` 401**：口令错误或会话过期（默认 4 小时）。
- **手机完全无声**：先看 `run/voice-log.jsonl` 里 `headerRepaired` 是否为 true。

---

## 2. 现在的架构

### 2.1 三条独立观察线

系统没有「模式」选择，三条线各自运行：

| 线 | Agent | 何时运行 | 由谁决定 |
|---|---|---|---|
| ① 场景/地点 | `SceneAgent` | 有非静止动作时（≤ 每 10s 一次） | VLM（画面 + 场景记忆） |
| ② 场景变化 | `SceneChangeAgent` | 画面稳定 + 有视觉新意（≤ 每 10s 一次） | VLM（基线 vs 当前） |
| ③ 用户要求 | `RequestAgent` | 用户显式提交，关注类每 ~8s 复核 | VLM |

运动信息只作为**定性的运动模式**自然语言输入给 VLM，不参与硬判定，也不提供坐标。

### 2.2 语音通道与安全通路（本线重点）

所有候选语句最终抢同一条声道，调度由 `src/agent/response-arbiter.ts` 决定：

- 优先级固定为 `safety < clarify < task < ambient`（数字越小越急），同级按到达时间先来先播。
- 抢占只在「更急的类型」对「更缓的类型」时发生；被打断的语句回到队列，未过期则稍后重播。
- 重复抑制分层：`latchKey` 标识的持续危险按 3 秒提醒间隔放开重播；相同文本 15 秒内不重复；**安全行不受按类型的 1.5 秒冷却约束**——否则两条不同的危险相隔 1.5 秒时，后一条会被当成重复静默丢弃。

危险链路：`hazard-check.ts`（在线与离线共用同一份模型调用）→ `/api/hazard` → 生成 `safety` 候选 → 抢占声道。`hazard-replay.ts` 可按人工标注回放历史帧，单独统计漏报与误报。

### 2.3 场景记忆（基础实现）

`SceneAgent` 维护一个地点列表，每个地点有 `label / summary / objects / visits` 和最多 5 张代表帧。观察前用本地匹配器 `scripts/image_match.py`（SIFT + 比值检验 + RANSAC 单应）判断「两张图是否共享同一块表面」，内点数达到阈值才把代表图拼进提示词。阈值刻意偏严：两个视角若没有共同纹理表面，宁可不合并，也不猜。

### 2.4 用户要求（RequestAgent）

- `question`（答一次）、`goal`（持续给简短建议）、`watch`（条件监控，只在确实发生时提示一次）。
- 输出为自然语言 `answer` + 控制位 `{kind, shouldSpeak, done, confidence}`。
- 明确告诉模型「画面只是用户前方的窄视野、无深度」，方位用相对用户或已知物体表达，看不到就直说看不到。

### 2.5 服务端接口（`src/trial-server.ts`）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/login` | 口令换 token（Bearer） |
| GET | `/api/state` | 当前会话工作状态 |
| POST | `/api/hazard` | 危险检测，产出 `safety` 候选 |
| POST | `/api/arbiter` | 语音通道仲裁决策 |
| POST | `/api/tts` | 语音合成（含流式 WAV 头修复） |
| POST | `/api/asr` | 语音识别 |
| POST | `/api/scene` | ① 场景记录 |
| POST | `/api/scene-change` | ② 场景变化 |
| POST | `/api/request` | ③ 用户要求 |
| POST | `/api/live/batch` | 持续保存帧 + 原始 IMU |
| POST | `/api/vio/burst` | 保存一段 VIO 录制 |
| POST | `/api/client-log` | 客户端语音链路诊断日志 |
| GET | `/report/*` | 离线轨迹报告 |

旧的 `/api/observe`、`/api/task`、`/api/watch` 仍在代码中，前端已不使用。

### 2.6 录制与离线分析

每个会话写入 `run/experiments/<session-id>/`：

```
session.json          会话元数据（模型、prompt 版本）
events.jsonl          场景/变化/要求/仲裁事件（含 arbiter_decision）
live/                 连续保存：frame-*.jpg、motion.jsonl、frames.jsonl
inputs/<runId>/       某次观察的原始 IMU 与输入帧
scene-memory/         地点代表帧
```

另有 `run/client-log.jsonl`（客户端语音链路）与 `run/voice-log.jsonl`（每次 TTS 合成结果）。

### 2.7 项目结构

- `src/`：TypeScript 服务与 Agent（`agent/hazard-*.ts`、`agent/response-arbiter.ts`、`agent/scene-agent.ts`、`agent/request-agent.ts`、`agent/place-memory.ts` 等）
- `src/sim/`：离线评测入口（`arbiter-compare.ts`、`arbiter-sweep.ts`、`hazard-replay.ts`）
- `web/`：手机网页（`app.js`、`index.html`、`vio.html`、`vio-flow.js`、`motion-fusion.js`）
- `scripts/`：Python 工具（图片匹配、变化检测）与 `setup-lan-tls.ps1`
- `docs/`：文档索引见 [docs/README.md](docs/README.md)
- `run/`、`datasets/`：本地实验记录与数据（已 git 忽略）

### 2.8 配置

| 变量 | 说明 |
|---|---|
| `QWEN_API_KEY` / `QWEN_BASE_URL` | 必填，Qwen OpenAI 兼容接口 |
| `QWEN_MODEL` | 可选，默认 `qwen3-vl-plus` |
| `VLM_TRIAL_PASSCODE` | 必填，试用口令 |
| `VLM_TRIAL_PORT` | 可选，默认 8765 |
| `VLM_PYTHON` | 可选，图片匹配用的 Python 路径 |
| `VLM_EXPERIMENT_ROOT` | 可选，实验记录根目录 |

---

## 3. 评测工具（本线自有的口径）

```powershell
npm.cmd run test:hazard          # 危险线与仲裁 37 项
npm.cmd run test:place           # 场景记忆 基础行为
npm.cmd run sim:arbiter -- --scenario hazard-mid-answer   # 构造场景：长回答播到一半时检出危险
npm.cmd run sim:arbiter -- --session latest               # 回放真实会话的仲裁候选
npm.cmd run sim:arbiter:sweep                             # 工作量扫描：27 格 × 24 种子 × 3 策略
```

评测遵循两条纪律：

1. **反事实回放**：只取记录里的候选语句与到达时刻，忽略记录自身的决策，重新走两套调度。差异只可能来自策略。
2. **计数必须自洽**：`spoken + neverSpoken == arrivals` 不成立时直接抛错，不输出表格。

已产出的结论（可复现，见 `run/arbiter-sweep/`）：`safety-first` 在 27 个工作量格子里安全行严格丢失为 0，基线 `fifo` 27 个格子全部有丢失（7.7%–36.4%），代价是每 288 次回答多打断约 0.33 次。这些数字来自假设的到达过程，不是真机统计——真机漏报率至今仍是空白。

---

## 4. 目前还要做的

- **真机危险漏报率**：需要 `QWEN_API_KEY` 与一次连续行走的人工标注，`hazard-replay` 才能算出漏报/误报。目前为 0 个数据点。
- **工作量模型拟合**：`sim:arbiter:sweep` 的到达率是假设值，需要用真实会话日志拟合后再报结论。
- **中间策略**：现有策略空间只有「安全优先」和「FIFO」两端，缺「安全行限长压缩」「长回答摘要后续播」这类折中，帕累托前沿因此只有端点。
- **场景粒度**：同一房间的不同角落仍会被拆成两个地点（视场太窄、无共同表面）。
- **运动可信度**：转身角度只报 1 秒窗口的转角和，长时间转会被低估；位移只有定性描述。

---

## 5. 本项目的固有局限

- **单目、窄视野、无尺度**：一次只能看到前方一小块，光流无法恢复真实米数。
- **不是导航或避障设备**：不提供测距、绝对定位或可靠方向；历史观察过的物体不等于此刻在场。
- **模型本身不确定**：同一输入两次回答可能不同；做法是固定协议、保留原始响应，而不是反复挑结果。
- **样本量小**：所有结论来自有限的录制会话，不足以声称泛化。
