# cc-dsh

在手机上操控电脑上的 **DeepSeek Harness（DSH）**。

它由两部分组成：

- **cc-dsh 插件**：跑在电脑的 DSH 进程里，提供带鉴权的手机网关 + 一个手机版网页界面；
- **cc-dsh APK**：约 25 KB 的原生外壳，只负责配对、保存信任、承载界面。

手机连上以后，可以看会话、继续对话、切换模型 / 模式 / 权限、看工作区文件、跑命令、改 DSH 设置、处理目标与计划任务 —— 用的都是 DSH 自己的服务和数据，不存在"两套状态"。

> 本项目在 **DSH desktop 0.2.1-rc.5** 上开发并验证；DSH 的 Host 服务签名若发生大的变化，插件需要相应调整。

---

## 特性

| 能力 | 说明 |
| --- | --- |
| 会话 | 列表、搜索、运行状态、子代理会话过滤、新建 / 重命名 |
| 对话 | 完整历史、逐字流式输出、思考过程折叠、工具调用折叠卡片 |
| 输入 | 发送、停止、运行中追加、带图发送（≤4 MB，需模型支持图片） |
| 模型 | 按供应商分组的全部可路由模型，切换即写入该会话 |
| 模式 | Agent 预设（standard / ptc / minimal / cordis…） |
| 权限 | 只读 / 仅工作区 / 完全访问，直接改该会话的沙箱与审批策略 |
| 审批 | 「接管 30 分钟」期间，工具调用推到手机，可允许 / 拒绝 |
| 文件 | 按会话工作目录浏览，点文件看文本（>2 MB 或二进制拒绝） |
| 命令 | 逐条执行 PowerShell / sh，输出实时回流、显示退出码、可中断 |
| 设置 | 读取并可改 DSH 各设置组里的 volatile 字段 |
| 目标 | 看目标、阶段、轮次，暂停 / 继续 / 完成 / 清除 |
| 计划任务 | 列出提醒、新建、删除 |
| 插件 | 列出可开关的插件，开关即时生效 |

## 架构

```
┌──────────────────┐        HTTP + SSE         ┌──────────────────────────────┐
│  cc-dsh APK       │  ───────────────────────▶ │  cc-dsh 插件（DSH 进程内）    │
│  WebView + 配对    │                           │                              │
└──────────────────┘                           │  sessionController  会话/模型 │
                                               │  agentPresets       预设      │
                                               │  permissionPresets  权限      │
                                               │  pluginManager      插件      │
                                               │  settings           设置      │
                                               │  fs / subprocess    文件/命令 │
                                               │  goals / schedule   目标/提醒 │
                                               └──────────────────────────────┘
```

手机只跟插件通信；插件以进程内 owner 身份调用 DSH 的 Host 服务，因此不需要反向解析 DSH 的私有协议，也不用第二套后端。

## 目录结构

```
plugin-ccdsh/           DSH 插件（Host + 一个设置页 Client 模块）
  index.js              入口：启动网关、注册清理
  lib/gateway.js        HTTP 路由 / SSE / 鉴权 / 局域网发现 / 静态资源
  lib/state.js          设备令牌、配对码（内存）、原子持久化
  lib/dsh.js            DSH Host 服务适配层
  lib/approvals.js      审批接管
  web/                  手机界面（无构建步骤的 HTML/CSS/JS）
  client.js             DSH「设置 → 手机连接」面板
android-shell/          Android 外壳（原生 Java，无 Gradle）
  app/src/main/...      WebView、配对、SSL 固定、文件选择、下载
  build-apk.ps1         直接调用 aapt2 / javac / d8 / apksigner 的构建脚本
docs/tailscale.md       电脑版 + 手机版 Tailscale 安装与使用
```

## 快速开始

### 0. 前置

- 电脑上装好 **DeepSeek Harness** 桌面版，能正常对话；
- 手机与电脑在**同一 Wi-Fi**，或者两边都连上 **Tailscale**（异地场景，见 [docs/tailscale.md](docs/tailscale.md)）。

### 1. 安装插件

把 `plugin-ccdsh` 目录装进当前 profile（任选其一）：

- 用 DSH 的插件管理界面「安装本地目录」，选中 `plugin-ccdsh`；
- 或用 `plugin_manager` 工具：`install_bundle`，target 指向该目录的绝对路径。

安装后插件会监听 `0.0.0.0:7317`（端口被占用时自动换随机端口，日志里会打印实际地址）。

### 2. 安装 APK

- 下载 Release 里的 `cc-dsh.apk`；或
- 自行构建（见下文「自行构建」），产物在 `dist/cc-dsh.apk`。

### 3. 配对

1. 打开 App，点「在同一 Wi-Fi 下自动查找」，或直接填 `电脑IP:7317`；
2. **第一次配对码留空**，点「连接」。

> 首次免码是有意设计：此时电脑上还没有任何已配对设备，没有可保护的对象，而手机本来就在同一网段。配对成功后，再加第二台手机就必须输入电脑上显示的 6 位配对码。

### 4. 之后添加手机 / 换手机

电脑端：DSH **设置 → 手机连接**，可以看到 6 位配对码、局域网 / Tailscale 地址、已配对设备（含平台与配对时间，可重命名、移除）。

## 异地使用（不在家）

用 **Tailscale** 把手机和电脑放进同一个私有网络，然后用电脑的 `100.x.y.z:7317` 访问。完整步骤（含 Windows 防火墙、常见故障）见 **[docs/tailscale.md](docs/tailscale.md)**。

不建议把 7317 端口映射到公网：网关是明文 HTTP，只应在可信网络里暴露。

## 安全模型

- 每台手机一个 32 字节随机设备令牌，电脑上只存 SHA-256；
- 首次配对仅接受**私有地址**（10/8、172.16/12、192.168/16、100.64/10、回环）；
- 配对码 6 位、10 分钟轮换、一次有效，仅存内存；
- 回环请求视为电脑所有者，用于设置页读取配对码 / 重命名设备；
- 设备令牌可在「手机连接」里随时移除；
- 局域网内是明文 HTTP：请在个人 Wi-Fi 或 Tailscale 内使用，不要走公共 Wi-Fi。

## 已知限制

1. **终端是"逐条命令"而不是交互式 PTY**：适合 `ls` / `git` / `npm test`，TUI 程序请在电脑上操作。实现走 `ctx.subprocess` 直接启动平台 shell，因此在 `ctx.shell` 未挂载或指向 bash（而系统没有 bash）的环境里也能工作；但需要 profile 里有 `subprocess` 服务（DSH 官方 `dsh-experimental-terminal-bundle` 会带上它）。
2. **审批接管是"接管"语义**：开启期间电脑端的审批弹窗可能停留到超时（DSH 的审批没有带外答复通道），到点会自动交还电脑。
3. **设置只开放 volatile 字段**：布尔 / 数字 / 字符串 / 枚举，嵌套对象与需要重启的项不在这里改。
4. 文件只能在线预览文本，没有下载到手机；暂不支持把手机文件上传到电脑（图片除外）。

## 自行构建

插件是纯 ESM，**不需要构建**，装进 profile 即可。

APK 用仓库自带的脚本构建，不依赖 Gradle / Flutter / 网络：

```powershell
# 需要：Android SDK（build-tools + platforms;android-36）与 JDK 17+
pwsh ./android-shell/build-apk.ps1

# 自定义位置
pwsh ./android-shell/build-apk.ps1 -AndroidSdk C:\Android\sdk -JavaHome "C:\Program Files\Java\jdk-21"
```

脚本会在 `build-keys/ccdsh.keystore` 生成签名密钥（已 gitignore）。**请保留它**：换一个密钥签名的 APK 无法覆盖安装。

## HTTP API 速查

所有 `/api/*`（除 `ping`、`pair`）都需要设备令牌或来自回环。

```
GET  /api/ping                     健康检查
POST /api/pair                     { code?, name, platform?, userAgent? } → { token, deviceName }
GET  /api/bootstrap                会话 / 模型 / 预设 / 工作区 / 权限 / 插件 / 待审批
POST /api/sessions                 { workspaceId? | cwd?, preset? } → { sessionId }
GET  /api/sessions/:id/stream      SSE：snapshot → event… → assistant-stream…
POST /api/sessions/:id/prompt      { text, mode?: 'queue'|'steer', images?: [...] }
POST /api/sessions/:id/cancel | rename | model | preset | permission
GET  /api/files?session=&path=     目录列表
GET  /api/files/read?session=&path=
GET  /api/runs?session=            最近命令
POST /api/runs                     { session, command } → { id }
GET  /api/runs/:id?cursor=         增量输出
POST /api/runs/:id/kill
GET  /api/settings                 设置组 + 字段
POST /api/settings/:ns             { patch, revision }
GET  /api/goal?session= ; POST /api/goal/:action
GET  /api/schedules ; POST /api/schedules ; POST /api/schedules/delete
GET  /api/plugins ; POST /api/plugins/:entryId/toggle
POST /api/approvals/arm ; POST /api/approvals/:id
GET  /api/server                   地址 / 设备 / 配对码（仅回环）
```

## License

MIT，见 [LICENSE](LICENSE)。

---

## English summary

**cc-dsh** lets an Android phone drive DeepSeek Harness running on your PC. A small DSH plugin
hosts an authenticated HTTP/SSE gateway and a mobile web UI; a ~25 KB native APK provides pairing,
trust storage and a WebView shell. Because the plugin calls DSH's own Host services in-process,
sessions, models, presets, permissions, files, commands and settings stay consistent with the
desktop app. Pair the first phone with no code while on a private network; later phones use a
rotating 6-digit code shown in **Settings → Phone**. For remote use, put both devices on
[Tailscale](docs/tailscale.md) and open `http://<tailscale-ip>:7317`.
