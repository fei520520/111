# First Sight · 第一视角视觉助理（手机摄像头 + Qwen VLM）

**当前快照：v1.1.0-test.4 · 研究测试版**（2026-10-12）

**空间记忆算法已初步可用（离线研究链路）**：已固定主体区域＋边界组／边界观察协议，可组织观察并关联具体区域，保留边界与未知状态。val4粗粒度44个核心查询44/44正确，但边界仅检出4/13；val5还没有完整审核标签。这是进入扩大测试与精确人工标注前的阶段性基线，不代表长期历史身份匹配、真实头盔或实时生产可靠性已验证。

人工检查网站已支持通过／不通过及拒绝理由，无需审核者姓名；两条路线已用模拟器重新渲染中间位姿，以24fps播放，三视图间留缝，无淡化或重复补帧。原始样本和算法输入不变，新增视频仅用于展示。

主体区域＋边界组／边界观察协议已固定为[研究算法v1](docs/research/boundary-region-algorithm-v1.json)，默认qwen3.8-flash，仅离线研究。val4粗粒度44核心查询正确，边界仅4/13检出；val5扩展40观察尚待人工审核，模型引用协议失败已保留并隔离未定。[人工视频审查网站](docs/research/human-review-site.md)支持97样本的播放、跳转、AI标签查看与人工修改导出。

固定查询评测、广角模拟和可选VLM全局聚合已归档；独立聚合试验默认`qwen3.8-flash`。历史test.3整组协议为32/44（72.7%），12卧室核心查询因边界疑点未定；当前边界协议为44/44，二者分别保留，不能混作独立可靠性证明。见[拒答诊断](docs/research/vlm-abstention-diagnosis.md)。VLM不接入默认生产算法，手机为旧实现，头盔采集驱动仍待调试。

本版固定离线三视图视觉记忆研究链路，手机应用暂不改动、不接入该链路。普通手机单摄输入不等同于研究用前/左/右三视图。回溯修复仅通过独立实验命令选择启用，默认归类保持不变；结果仍未达到可靠区域识别标准。

具体差异见[研究与应用鸿沟](docs/research/research-application-gap.md)：多镜头手机不等于前/左/右视野，转动单摄顺序拍摄也不等于同步三视图；须另做硬件采集与单摄评测，不能直接移植研究成绩。[原始建议材料](docs/notes/suggestions/README.md)已集中归档。

稳定版基线仍是 `v1.0.0`（2026-10-04）。当前快照包含此前 SceneAgent/PlaceMemory 修改，以及独立的 Experience Graph 和区域分割实验；空间组织与边界聚合研究算法已初步可用，但未接入实时助理，尚不代表生产自动地点分组可靠性通过。

- [测试版说明与复现入口](docs/testing-version.md)
- [实验文档索引](docs/experiments/README.md)
- [原图与真实轨迹核验](docs/archive/region-partition-actual-review.md)
- [替换方法还是训练：研究决策](docs/research/region-methods-and-training.md)

一个手机浏览器里的第一视角视觉试用工具：手机摄像头连续取景，服务端用 Qwen 多模态模型理解画面，对外表现为**三条互相独立的观察线**——场景记录、场景变化、用户要求。

**当前研发方向更新**：头盔三摄与方向模块仅负责数据采集，所有处理继续在电脑执行。[兼容接口](docs/research/helmet-capture-interface.md)已预留，实际驱动尚未实现。以下手机浏览器功能是[保留的旧实现](docs/archive/mobile-implementation-status.md)，不作为新空间研究接入目标。

> V1 定位：一个**可稳定演示**的体验版。不提供可靠的安全导航、测距或绝对定位能力；运动信息只作定性参考，是否切换场景由 VLM 判断。

---

## 1. 使用说明（iOS / Android）

完整步骤见 [docs/application/mobile-trial.md](docs/application/mobile-trial.md)，下面是速览。

### 1.1 前置

- Windows 电脑 + 同一 Wi-Fi 下的手机（iPhone 或 Android）。
- Node.js ≥ 20；Python 3 + OpenCV（图片记忆用，见 `requirements.txt`）。
- 服务端环境变量：`QWEN_API_KEY`、`QWEN_BASE_URL`，可选 `QWEN_MODEL`（默认 `qwen3-vl-plus`）。

### 1.2 电脑端准备

```powershell
npm.cmd install
python -m pip install -r requirements.txt          # 建议装在 .venv 里

# 生成局域网 HTTPS 证书（写 run/tls/：CA 证书 + 服务器证书 + 局域网 IP）
powershell -ExecutionPolicy Bypass -File scripts/setup-lan-tls.ps1
```

### 1.3 启动服务

```powershell
$env:VLM_TRIAL_PASSCODE = "zpf"      # 至少 3 位的临时口令
npm.cmd run trial:web
```

终端会打印两个地址：

- 网页：`https://<LAN-IP>:8765/vlm`
- CA 安装页（普通 HTTP）：`http://<LAN-IP>:8767/`

### 1.4 手机安装并信任 CA（关键）

**iOS**：

1. 用 **Safari** 打开 `http://<LAN-IP>:8767/`，下载 `vlm-local-ca.cer`。
2. `设置 → 通用 → VPN 与设备管理 → VLM Local Dev CA → 安装`（输入锁屏密码）。
3. `设置 → 通用 → 关于本机 → 证书信任设置`，打开 **VLM Local Dev CA 的完全信任**。

**Android（Chrome）**：

1. 用 **Chrome** 打开 `http://<LAN-IP>:8767/`，下载 `vlm-local-ca.cer`。
2. `设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书`，选择该文件并确认。
3. `设置 → 安全 → 加密与凭据 → 受信任的凭据 → 用户` 中确认已存在。

> 不信任 CA，浏览器会拦截 `https://<LAN-IP>:8765`；换 IP 后需重装。
> 打不开 `http://<LAN-IP>:8767` 时（确认用 `http://`、且与电脑同一 Wi-Fi），改用 `https://<LAN-IP>:8765/ca` 下载同一张证书（先忽略证书警告）。

### 1.5 打开试用页

1. 用手机浏览器打开 `https://<LAN-IP>:8765/vlm`，输入口令登录。
2. 点“开启摄像头”：
   - **iOS**：允许摄像头，并允许**运动与方向**权限（必须，否则运动模式不可用）；
   - **Android（Chrome）**：只需允许摄像头，运动传感器无需手势授权，且通常能提供陀螺仪角速度。
3. 页面三条线：
   - **场景**：显示当前地点，以及新场景 / 回到已知场景 / 同一场景；
   - **场景变化**：同一地点内部的非位移变化（物体移动、人出现、开关门等）；
   - **用户要求**：填问题/目标点“提问 / 设定目标”；填关注条件点“关注这个情况”。

### 1.6 其他页面与命令

| 入口 | 用途 |
|---|---|
| `/vlm` | 主试用页（三条观察线） |
| `/vio` | VIO 探针，`记录 12 秒` 采集灰度帧 + IMU，供离线分析 |
| `/report` | 离线运动轨迹报告列表 |
| `npm.cmd run vio:plot` | 由最新一段 VIO 录制生成轨迹报告 |
| `npm.cmd run motion:plot` | 由最近会话的 IMU 生成航位推算轨迹报告 |

### 1.7 常见问题

- **证书不受信任**：回到 1.4 第 3 步开启完全信任。
- **没有运动数据**：确认允许了“运动与方向”；部分会话 `alpha` / `rotationRate` 可能为空。
- **`/api/...` 503**：服务端未配置 `QWEN_API_KEY` / `QWEN_BASE_URL`。
- **`/api/...` 401**：口令错误或会话过期（默认 4 小时）。
- **图片匹配从不触发**：确认 Python 能 `import cv2`。

---

## 2. 现在的架构

### 2.1 三条独立观察线

系统不再有“模式”选择，三条线各自独立运行：

| 线 | Agent | 何时运行 | 由谁决定 |
|---|---|---|---|
| ① 场景/地点 | `SceneAgent` | 手机有非静止动作时（≤ 每 10s 一次） | **VLM**（画面 + 场景记忆） |
| ② 场景变化 | `SceneChangeAgent` | 画面稳定 + 有视觉新意（≤ 每 10s 一次） | **VLM**（基线 vs 当前） |
| ③ 用户要求 | `RequestAgent` | 用户显式提交（提问/目标/关注条件），关注类每 ~8s 复核 | **VLM** |

运动信息只作为**定性的“运动模式”自然语言**输入给 VLM，不参与硬判定。

其中 **② 场景变化** 的做法以 **VLM 判定为主**：先由 **① 判定“是不是同一场景”**；同一场景时把当前帧与该场景的**规范基线**（该场景**第一次记录的视图**，不被后续画面覆盖）做配准（SIFT + RANSAC 单应），**只比较重叠区内部**并做亮度归一，找出候选的局部残差块。像素检测**只用来在“能可靠判定无变化”时跳过 VLM**（配准可靠且无显著残差块）；**其余情况一律交给 VLM**（有候选变化块，或配准不可靠、无法判定），由 VLM 比较基线与当前图，判断场景内容是否真的变了（物品移动/增减、灯/屏幕状态），并忽略取景、角度、曝光差异。因此**取景和角度的差异不会被当成场景变化**，而算法不确定时也不会漏——交给 VLM。

```
摄像头帧 ─┬─► SceneAgent(VLM + 场景/图片记忆) ─► 新场景 / 回到已知场景 / 同一场景
          ├─► SceneChangeAgent(VLM 基线对比)     ─► 场景内变化事件
          └─► RequestAgent(VLM + 用户要求)        ─► 回答 / 建议 / 关注提示
运动模式(VIO, 自然语言) ─┘（辅助上下文）
```

### 2.2 场景记忆与图片记忆（本项目的重点）

- `SceneAgent` 维护场景库：每个场景有 `label / summary / objects / visits`，以及**若干张代表帧**（磁盘上 `run/experiments/<session>/scene-memory/scene-N/rep-*.jpg`，默认每次观察存最多 2 张、每场景上限 5 张）。
- 每次观察前，本地匹配器 `scripts/image_match.py`（SIFT + 比值检验 + RANSAC 单应）把**当前所有帧**与代表帧比对，回答“两张不同视角的图是否共享同一块表面”（例如**书桌特写 vs 含书桌的宽景**）。
- **记忆里的图片默认不给 VLM**；只有当匹配内点数达到阈值（默认 15）时，才把命中的那张代表图 + 其标签 + `IMAGE_MATCH` 提示一起拼进 prompt，让 VLM 复核“是不是同一处”。
- 匹配只对**最近 5 个场景 × 2 张**候选进行，规模有界；每张图长边缩到 900px。实测：同一视角 250–900 内点，不同视角 4–8 内点，阈值能分开。
- 价值场景：**离开又回来**（非相邻访问判为“回到已知场景”）、**特写↔全景**。对“同一房间但毫无共同表面的两个角落”，它**不会**硬合并——这是刻意保守。

### 2.3 运动模式（VIO / 惯导）

- 端上 VIO-lite：`web/vio-flow.js`（160×120 灰度块匹配光流）+ `web/motion-fusion.js`（陀螺仪补偿后融合成 still / move / turn 段），产出自然语言“运动模式”。
- `src/dead-reckoning.ts` / `activity-motion.ts`：标定（起始静止 3s）→ 去重力 → 积分 → 零速校正（ZUPT），得到**低置信度的米制参考**。
- 平台：Android Chrome 通常提供陀螺仪 `rotationRate`，VIO 优先用它计算短时 yaw，并优先监听 `deviceorientationabsolute`；iOS 的 `rotationRate` 常为空，退回 `alpha` 差分。
- **结论：运动模式只能定性，轨迹不可靠。** 累计路程比净位移可信；匀速平移、连续扫视、快动作、弱纹理都会失效。VLM 收到的是“大约怎么动了”的文字，不是速度/方向向量/坐标。

### 2.4 用户要求（RequestAgent）

- 支持 `question`（答一次即结束）、`goal`（持续给简短建议）、`watch`（条件监控，**只在确实发生时提示一次**）。
- 输出为自然语言 `answer` + 控制位 `{kind, shouldSpeak, done, confidence}`；模型未微调，尽量少结构化。
- **空间参照**：明确告诉 VLM“画面只是用户前方的**窄视野**（≈正前方一小块，无深度）”，方位用**相对用户或相对已知物体**表达（“你右手边、笔记本电脑左侧”），**不用图片坐标**（“图片右侧”）；**看不到就直说看不到**并建议怎么找，不瞎猜。
- **实时/语音**：走轻量路径（默认 2 帧、短提示），目标是"问完即答"；支持浏览器**语音输入**（🎤，Web Speech API）与**语音播报**（`speechSynthesis`）。Android Chrome 的语音识别可用，iOS Safari 支持有限；播报两平台都可用。
- **默认独立**：不依赖 ①/②；给 agent 一个**可选的 `search_scene_memory` 工具**（查询已访问地点与最近变化），由 **agent 自己决定何时调用**——只在与地点/回忆/变化相关的提问时才用，而不是被动附带记忆。
- 关注类要求由前端定时（~8s）带最新帧复核。

### 2.5 服务端接口（`src/trial-server.ts`）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/login` | 口令换 token（Bearer） |
| GET | `/api/state` | 当前会话工作状态 |
| POST | `/api/scene` | ① 场景记录 |
| POST | `/api/scene-change` | ② 场景变化 |
| POST | `/api/request` | ③ 用户要求 |
| POST | `/api/live/batch` | 持续保存帧 + 原始 IMU |
| POST | `/api/vio/burst` | 保存 `/vio` 探针的一段录制 |
| GET | `/report/*` | 离线轨迹报告 |

> 旧的 `/api/observe`、`/api/task`、`/api/watch` 仍保留在代码中，但前端已不再使用（见 §3）。

### 2.6 录制与离线分析

每个会话写入 `run/experiments/<session-id>/`：

```
session.json          会话元数据（模型、prompt 版本）
events.jsonl          场景/变化/要求事件（含 match 内点数）
runs.jsonl            旧 observe 流程的历史运行记录
live/                 连续保存：frame-*.jpg（~1/s）、motion.jsonl（原始 IMU）、frames.jsonl
inputs/<runId>/       某次观察的原始 IMU（motion.json）与输入帧
scene-memory/scene-N/ 场景代表帧（图片记忆）
```

离线工具：`scripts/image_match.py`（图片记忆匹配）、`scripts/image_change.py`（局部变化检测）、`scripts/image_overlap.py`，以及 `npm run vio:plot` / `motion:plot` 生成的 HTML 报告（`run/analysis/`，可用 `/report` 查看）。

### 2.7 项目结构

- `src/`：TypeScript 服务与 Agent（`agent/scene-agent.ts`、`scene-change-agent.ts`、`request-agent.ts`、`image-match.ts`；运动相关 `dead-reckoning.ts` 等）
- `web/`：手机网页（`app.js`、`index.html`、`vio.html`、`vio-flow.js`、`motion-fusion.js`）
- `scripts/`：Python 工具（图片匹配、抽帧、识别基线）与 `setup-lan-tls.ps1`
- `docs/`：文档，见 [docs/README.md](docs/README.md)
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

## 3. 目前还要做的

- **场景粒度**：同一房间的不同角落仍会被拆成两个场景（视场太窄、无共同表面）。需要更强的“同一地点”判据或更大的视野。
- **场景变化的真机验证**：受条件限制，`SceneChangeAgent` 尚未在手机上完整测过；基线与标签联动还需实测。
- **用户要求真机验证**：`RequestAgent` 只做了服务端/离线验证，需在手机上确认问答与关注提示的体验。
- **转身角度不可靠**：融合只报“1 秒窗口”的转角和，长时间转会被低估；原始 `alpha` 又会漂移，需要更好的去偏或优先用陀螺 `rotationRate`。
- **取帧策略**：目前是“窗口内取最旧+最新+最不相似”的启发式；可按画面复杂度自适应帧数。
- **图片记忆调优**：阈值（现 15 内点）、每场景代表帧数（现 5）、描述子缓存与性能；目前每次现算 SIFT，约 +1–1.5s。
- **清理历史代码**：移除前端已不用的 `/api/observe` / `/api/task` / `/api/watch` 与相关状态机。
- **安全通路**：没有独立的高优先级安全事件低延迟检测。

---

## 4. 本项目的固有局限性

- **手机摄像头视场太窄**：一次只能看到房间的一小块，VLM 天生“看不全”，场景身份判断因此不确定；更大视场或全景会显著改善。
- **单目、无尺度**：光流无法恢复真实米数；VIO 位移只能定性，不能定量。
- **惯导会漂移**：无绝对位置/坐标；匀速平移可能完全测不到；仅累计路程勉强可用。
- **局部重合有前提**：图片匹配要求两张图**确实有共同纹理表面**；模糊、弱纹理、白墙会失效——这正是我们选择“宁可不合”的原因。
- **VLM 的地点识别受限于可见内容**：没有共同表面的两个视角，无论算法还是模型都无法可靠合并。
- **传感器可用性因会话而异**：`alpha`、`rotationRate` 可能为空；iOS 需要显式授权。
- **不是安全/导航设备**：不提供测距、避障、绝对定位或可靠方向。

---

## 附：文档

- 文档索引：[docs/README.md](docs/README.md)
- 历史（四模式时期）架构：[docs/archive/architecture-legacy-4mode.md](docs/archive/architecture-legacy-4mode.md)
- 惯导说明：[docs/application/motion-dead-reckoning.md](docs/application/motion-dead-reckoning.md)
- 产品设计：[docs/application/product-design.md](docs/application/product-design.md)
