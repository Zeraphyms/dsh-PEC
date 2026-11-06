# 兼容性说明（DSH 升级后先看这里）

cc-dsh 直接调用 DeepSeek Harness 的 Host 服务，而 Harness 是快速迭代的。这份文档说明：

- 插件依赖什么、哪些是硬依赖；
- DSH 升级后 30 秒内怎么确认插件还行不行；
- 真出问题时怎么定位到具体服务，而不是"整个 DSH 崩了"。

## 设计上如何抗升级

1. **激活不抛异常**：`index.js` 的 `apply` 全程 try/catch。任何构造或注册失败只会让插件自己不可用，不会影响 profile 里其它插件和会话。
2. **能力探测**：每次启动探测一遍 `sessionController / sessions / agents / settings / workspaceRegistry / fs / subprocess` 的关键方法，缺哪个只禁用对应功能。
3. **按需降级**：终端没有 PTY 就退到持久 shell；没有 `credentials` 就只读供应商；没有 `archiveSession` 就隐藏归档入口。
4. **统一出口**：接口出错返回 503 并带上 `missing` 字段，直接告诉你缺哪个能力，而不是一个空洞的 500。
5. **客户端兜底**：设置页「手机连接」面板和手机端都包了渲染兜底，单块面板失败不会拖垮整个页面。

## 升级 DSH 后的 30 秒自检

在电脑上执行（PowerShell 或浏览器都行）：

```powershell
curl.exe -sS http://127.0.0.1:7317/api/health
```

返回里的关键字段：

| 字段 | 含义 |
| --- | --- |
| `ok` | `true` = 插件需要的 Host 能力全在 |
| `missing` | 缺失的服务或方法名，空数组表示没问题 |
| `optional` | 可选能力：`terminal.pty` / `settings.write` / `sessions.archive` / `providers` / `approvals` |
| `runtime` | Electron / Node / Chrome 版本，便于对照 DSH 发行版 |

手机端打开列表页时也会做同样的检查：不匹配会在顶部显示一条黄色提示，写明缺什么。

也可以跑仓库里的体检脚本（覆盖全部接口）：

```powershell
node .tools/smoke-test.cjs
```

## 历史兼容记录

| DSH | 插件 | 结论 |
| --- | --- | --- |
| 0.2.1-rc.5 | 1.0 – 1.5 | 基线 |
| 0.2.2-rc.1 | 1.6 | 接口全通；`assistant-stream` 帧改为嵌套 `frame.chunk.text`，插件早已按嵌套解析，无需改动 |
| 0.2.2-rc.1 | 1.6.1 | 增加 `/api/health` 自检、激活兜底、客户端渲染兜底 |

## 这次升级为什么会把 DSH 一起带崩

排查结论（0.2.1 → 0.2.2）：

- 插件本身没有写任何 Harness 配置文件，唯一的写入是「添加供应商」时的 `llm-pi-ai` 设置，以及终端 `pwsh-sandbox` 的路径项，二者都是正常设置项；
- 真正的高风险来源是 **`@deepseek-ai/dsh-experimental-terminal-bundle`**：它在 profile 里插入了 `dsh-terminal` + `dsh-terminal-bash` 的一组行，而 0.2.2 起终端已经是可选内置能力（`optional-terminal-*`），同名的终端注册表叠在一起时，组合失败会表现为"会话不可用 / 会话消失"；
- 因此插件的终端功能**不依赖**这个 bundle：它用的是基础服务 `subprocess`，`/api/health` 里的 `terminal.pty` / `terminal.pipe` 会告诉你当前机器上真 PTY 是否可用。

升级到 1.6.1 之后，如果你的 profile 里还留着那个 bundle，可以安全地把它从 `dsh.profile.bundles` 里去掉（终端不会消失，预置里的 `persistent-shell` 仍提供 PowerShell 终端）。

## 遇到问题时给开发者的信息

```powershell
curl.exe -sS http://127.0.0.1:7317/api/health
curl.exe -sS http://127.0.0.1:7317/api/server
```

以及手机端的具体表现（打不开 / 列表空 / 发消息没反应 / 某个面板报错）。有这三样基本能定位到是网关、Host 能力还是手机端缓存的问题。
