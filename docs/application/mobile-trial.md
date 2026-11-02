# 手机试用（iOS / Android · 局域网 HTTPS）

本项目在手机上是一个网页试用工具。摄像头和运动传感器都要求**安全上下文（HTTPS）**，所以先在电脑上生成一张本地 CA 证书，装到手机并信任，再用局域网地址访问。

## 0. 前置条件

- 一台 Windows 电脑和一部与电脑**同一 Wi-Fi** 的手机（iPhone 或 Android）。
- Node.js ≥ 20。
- Python 3 + OpenCV（图片记忆的匹配算法用；见 `requirements.txt`）。
- 已配置 Qwen 凭据（服务端环境变量）：`QWEN_API_KEY`、`QWEN_BASE_URL`，可选 `QWEN_MODEL`（默认 `qwen3-vl-plus`）。

## 1. 电脑端准备

```powershell
npm.cmd install
python -m pip install -r requirements.txt        # 建议装在 .venv 中

# 生成局域网 HTTPS 证书（写 run/tls/：CA 证书 + 服务器证书 + 局域网 IP）
powershell -ExecutionPolicy Bypass -File scripts/setup-lan-tls.ps1
```

生成物：

- `run/tls/vlm-local-ca.cer` —— 需要装到手机并信任的 CA
- `run/tls/vlm-server.pfx` —— 服务端证书
- `run/tls/lan-ip.txt` —— 局域网地址

## 2. 启动服务

```powershell
$env:VLM_TRIAL_PASSCODE = "zpf"      # 至少 3 位的临时口令
npm.cmd run trial:web
```

终端会打印：

- 网页：`https://<LAN-IP>:8765/vlm`
- CA 安装页（普通 HTTP，不需要证书）：`http://<LAN-IP>:8767/`

电脑上可先用 `http://localhost:8765` 检查界面。

## 3. 打开并授权

打开 `https://<LAN-IP>:8765/vlm`，输入口令登录，点“开启摄像头”：

- **iOS**：会弹两次权限——摄像头，以及“运动与方向”（`DeviceMotionEvent.requestPermission`），**都必须允许**，否则运动模式不可用。
- **Android（Chrome）**：只需要允许摄像头；`DeviceMotionEvent` / `DeviceOrientationEvent` **无需手势授权**，通常还会直接提供陀螺仪角速度（`rotationRate`），比 iOS 会话更完整。

页面三条独立观察线：**场景**（当前地点 / 新场景 / 回到已知场景）、**场景变化**、**用户要求**（提问 / 目标 / 关注）。

## iOS 安装并信任 CA

1. **下载**：用 iPhone 的 **Safari** 打开 `http://<LAN-IP>:8767/`，下载 `vlm-local-ca.cer`。
2. **安装描述文件**：`设置 → 通用 → VPN 与设备管理`，点开 “VLM Local Dev CA”，安装，输入锁屏密码。
3. **信任**：`设置 → 通用 → 关于本机 → 证书信任设置`，打开 “VLM Local Dev CA” 的**完全信任**。
   > 第 3 步不能省，否则 Safari 仍会拦截 `https://<LAN-IP>:8765`。

## Android 安装并信任 CA

1. **下载**：用 **Chrome** 打开 `http://<LAN-IP>:8767/`，下载 `vlm-local-ca.cer`（可能在“下载内容”里）。
2. **安装**：`设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书`（不同机型路径略有差异，也可能在 `设置 → 安全性与隐私 → 更多安全设置` 下），选择刚下载的文件。系统会提示该证书可见/有风险，确认继续。
3. **确认**：`设置 → 安全 → 加密与凭据 → 受信任的凭据 → 用户` 中应能看到 “VLM Local Dev CA”。
   > Chrome 信任用户安装的 CA，因此网页可用；Android 7+ 的普通 App 默认不信任用户 CA，这不影响浏览器。

> **打不开 8767？** 两个常见原因：地址应是 `http://`（不是 https）；或网络/防火墙拦截了该端口。此时改用主端口的下载页：手机浏览器打开 `https://<LAN-IP>:8765/ca`（会先弹证书警告，点“高级 → 继续前往”），即可下载同一个 CA。8767 只是方便你“在信任证书前”下载，主端口的 `/ca` 是等效的备用入口。

> 换 Wi-Fi / IP 变化后，需要重新运行 `setup-lan-tls.ps1` 并在手机上重装证书。

## 其他页面与命令

| 入口 | 用途 |
|---|---|
| `/vlm` | 主试用页（三条观察线） |
| `/vio` | VIO 探针，`记录 12 秒` 采集灰度帧 + IMU |
| `/report` | 离线运动轨迹报告列表 |
| `npm.cmd run vio:plot` | 由最新一段 VIO 录制生成轨迹报告 |
| `npm.cmd run motion:plot` | 由最近会话的 IMU 生成航位推算轨迹报告 |

## 平台差异

| | iOS Safari | Android Chrome |
|---|---|---|
| 摄像头 / 传感器是否要 HTTPS | 是 | 是 |
| 运动传感器权限 | 需手势调用 `requestPermission()` 并允许 | 无需授权 |
| 陀螺仪 `rotationRate` | 常为空，靠 `alpha` 差分 | 通常可用（yaw 估计更稳） |
| 绝对方位 | `alpha` 相对、易漂 | 优先监听 `deviceorientationabsolute` |
| 后台 | 定时器被节流 | 定时器被节流 |

## 常见问题

- **打不开 https / 证书不受信任**：iOS 见上第 3 步；Android 确认已装到“受信任的凭据 → 用户”。
- **打不开 8767**：确认用 `http://` 且与电脑同一 Wi-Fi；或直接用 `https://<LAN-IP>:8765/ca` 下载证书（先忽略证书警告）。
- **没有运动数据**：iOS 确认允许了“运动与方向”；Android 确认系统未关闭运动传感器权限。
- **`/api/...` 返回 503**：服务端未配置 `QWEN_API_KEY` / `QWEN_BASE_URL`。
- **`/api/...` 返回 401**：口令错误或会话过期（默认 4 小时）。
- **图片匹配从不触发**：确认 Python 能 `import cv2`。
- **后台不工作/画面卡顿**：保持页面前台、屏幕常亮；浏览器会节流后台定时器。
# 状态：当前手机试用链路

本文是手机试用链路的现行步骤，随服务端代码一起维护。研究与手机应用不做硬件层面的承诺：相机为单摄窄视野、无深度，运动信息只作定性参考。
