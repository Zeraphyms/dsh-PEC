# cc-dsh 插件 · 安装说明

这个压缩包是 **DSH 插件**本体（不是 APK）。APK 在同一次 Release 里，文件名 `cc-dsh-<版本>.apk`。

## 1. 解压

把压缩包解到任意一个**长期存在**的目录，例如：

```
D:\Tools\cc-dsh\plugin-ccdsh
```

解压后该目录里应该有 `package.json`、`index.js`、`cordis.patch.yml`、`lib/`、`web/`。

> 不要放在临时目录或被清理的下载目录：DSH 是链接这个目录来加载插件的，删掉就会失效。

## 2. 装进 DSH

任选其一：

- **插件管理界面**：DSH → 设置 → 插件 → 安装本地目录 → 选择上面的 `plugin-ccdsh` 目录；
- **命令行**：在 DSH 里让助手执行 `plugin_manager` 的 `install_bundle`，target 填该目录的绝对路径。

安装成功后，插件行名称为 `cc-dsh`，状态应为 active。

## 3. 确认网关起来了

插件会在 `0.0.0.0:7317` 起一个手机网关（端口被占用会自动换随机端口，DSH 日志里会打印实际地址）。

在自己电脑上验证：

```powershell
curl.exe http://127.0.0.1:7317/api/ping
# {"ok":true,"server":{"id":"...","name":"<你的电脑名>"}}
```

### 手机搜不到 / 连不上？先看 Windows 防火墙

家里的 Wi-Fi 在 Windows 上常被识别成 **"公用网络"**，公用配置默认**拒绝所有入站连接**——于是手机既收不到广播、也连不上 7317，表现就是「自动查找找不到」和「填 IP 也连不上」。

以管理员身份开一次 PowerShell，放行这两个端口即可（TCP 是网关，UDP 是局域网发现）：

```powershell
netsh advfirewall firewall add rule name="cc-dsh gateway" dir=in action=allow protocol=TCP localport=7317
netsh advfirewall firewall add rule name="cc-dsh discovery" dir=in action=allow protocol=UDP localport=55901
```

如果网关换了端口（7317 被占用），第一条命令里的端口要跟着改；插件启动日志里会打印实际端口。

排查顺序：在电脑上 `curl.exe http://<局域网IP>:7317/api/ping` 能通 → 说明监听正常，问题在防火墙或路由器；仍不通 → 看端口有没有被占用。

## 4. 配手机

1. 手机装 Release 里的 APK；
2. 手机与电脑在同一 Wi-Fi（异地则都连 Tailscale，见仓库 `docs/tailscale.md`）；
3. App 里点「自动查找」，或填 `电脑IP:7317`；
4. **首次配对码留空**，点「连接」。

之后再加手机，需要在电脑端 **设置 → 手机连接** 里看 6 位配对码（10 分钟轮换）。

## 5. 可选：终端面板

手机端的「终端」面板走 DSH 的 `subprocess` 服务。若你的 profile 没挂载它，面板会提示"没有启用子进程服务"，其余功能不受影响。补上它的方式：启用官方 bundle `@deepseek-ai/dsh-experimental-terminal-bundle`。

## 6. 卸载

插件管理里禁用或卸载 `cc-dsh` 即可。已配对记录保存在 `%DSH_HOME%\cc-dsh\state.json`（删掉该目录等于重置所有设备）。
