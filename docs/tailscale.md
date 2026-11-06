# 用 Tailscale 异地访问 cc-dsh

cc-dsh 的网关默认只监听本机所有网卡，**不经过任何中转服务**。不在家时，用 Tailscale 把手机和电脑放进同一个私有网络，就能像在同一 Wi-Fi 下一样访问。

Tailscale 给每台设备一个固定的 `100.x.y.z` 私有地址（CGNAT 段），两端都在线时直连，直连不通才走加密中继。它不需要公网 IP、不需要端口映射。

---

## 一、电脑版（Windows）

### 1. 安装

1. 打开 <https://tailscale.com/download/windows>，下载 `tailscale-setup-*.exe`；
2. 双击安装（需要管理员权限），装完托盘区会出现 Tailscale 图标；
3. 点图标 → **Log in**，浏览器会打开登录页，用 Google / Microsoft / GitHub / 邮箱任一方式登录。

> 记住你用的是哪个账号 —— 手机必须登录**同一个账号**（同一个 tailnet），否则互相看不见。

### 2. 确认已连接

托盘图标菜单里会显示本机地址，或在 PowerShell 里：

```powershell
tailscale ip -4          # 例：100.101.102.103
tailscale status         # 本机 + 同网络其它设备
```

第一条 `100.` 开头的地址就是手机要访问的地址。

### 3. 放行网关端口

cc-dsh 监听 `0.0.0.0:7317`。Windows 防火墙默认会拦入站，需要放行一次：

```powershell
# 管理员 PowerShell
New-NetFirewallRule -DisplayName "cc-dsh gateway (TCP 7317)" `
  -Direction Inbound -Protocol TCP -LocalPort 7317 -Action Allow -Profile Any
```

`-Profile Any` 同时覆盖"专用/公用/域"三种网络配置；Tailscale 的虚拟网卡在 Windows 里通常被归为"公用"，只给 Private 往往会连不上。

如果不想加这条规则，也可以在第一次运行时留意 DSH 的防火墙提示，选择"允许专用网络"——但那样在 Tailscale 下可能仍被拦。

### 4. 建议：关闭密钥过期

管理后台 → **Machines** → 找到这台电脑 → `…` → **Disable key expiry**。  
否则默认 180 天后设备需要重新登录，你会突然连不上手机端。

---

## 二、手机版（Android）

### 1. 安装

- **Google Play**：搜索 **Tailscale**（发布者 Tailscale Inc.）安装；或
- 从 <https://tailscale.com/download/android> 下载 APK 手动安装。

### 2. 登录并开启

1. 打开 App → **Sign in** → 选择**和电脑相同的账号**；
2. 回到首页，把顶部的开关打开（会请求 VPN 权限，允许即可）；
3. 列表里应能看到你的电脑，状态为 `Connected`。

### 3. 保持在线

Android 会为了省电杀掉后台 VPN。建议：

- 系统设置 → 应用 → Tailscale → 电池 → 选「**不受限制**」；
- 部分国产 ROM 还需要在「自启动 / 后台运行」里放行 Tailscale。

---

## 三、在 cc-dsh 里使用

1. 手机打开 Tailscale 并确认已连接；
2. 打开 cc-dsh App；
3. 地址栏填电脑的 Tailscale 地址：

   ```
   100.101.102.103:7317
   ```

   如果开了 **MagicDNS**（管理后台 → DNS → Enable MagicDNS），也可以直接填机器名：

   ```
   我的电脑:7317
   ```

4. 点「连接」。第一次免配对码；换手机时输入电脑上显示的 6 位码。

连上以后，手机无论在哪个网络（4G/5G、公司 Wi-Fi、酒店 Wi-Fi）都能用，和在家里一样。

---

## 四、验证与排错

### 连通性

```powershell
# 电脑上：看手机是否在线
tailscale status

# 电脑上：直接测网关
curl.exe http://127.0.0.1:7317/api/ping
```

手机上如果连不上，先确认**手机浏览器**能不能打开 `http://100.x.y.z:7317/api/ping`：

- 浏览器能开、App 不能 → 检查 App 里填的地址是否带端口；
- 浏览器也开不了 → 是 Tailscale 或防火墙的问题，继续往下看。

### 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 手机能看到电脑，但连不上 7317 | Windows 防火墙没放行：执行上面的 `New-NetFirewallRule`；确认 DSH 正在运行且插件已启用 |
| App 一直转圈 / 提示配对失效 | 电脑上插件重启后端口可能变了（端口被占用会换随机端口），到 DSH 日志里看实际地址，或把 7317 腾出来 |
| 隔一段时间就连不上 | 手机端 Tailscale 被系统省电杀掉；把 Tailscale 设为「不受限制」，并在最近任务里锁定它 |
| 管理后台显示 `last seen ...` 很早 | 手机 Tailscale 没在运行，或登录的是另一个账号 |
| 速度慢 | `tailscale status` 里显示 `relay "xxx"` 表示走了中继（NAT 打洞失败）。家庭宽带一般直连；公司网络可能需要放行 UDP 41641，或接受中继 |
| 想彻底不通外网也能用 | Tailscale 本身就是加密的点对点网络，网关不需要暴露公网；不要给 7317 做路由器端口映射 |

### 安全提醒

- 网关是**明文 HTTP**：只应在 Tailscale 或你自己的 Wi-Fi 内使用，不要暴露到公网；
- 管理后台的 **Access controls / ACL** 若做了限制，确保手机与电脑在同一 tailnet 且互相允许 `*:*`；
- 不再使用的手机，记得在 cc-dsh「设置 → 手机连接」里移除设备，同时在 Tailscale 后台移除该设备。

---

## 附：不用 Tailscale 的替代方案

- **同一 Wi-Fi**：直接用电脑的局域网地址（如 `192.168.1.100:7317`），无需任何额外软件；
- **其他组网工具**（ZeroTier、frp 等）：只要能让手机访问到电脑的 7317 端口即可，cc-dsh 不关心底层网络；
- **Cloudflare Tunnel 之类的公网隧道**：技术上可行，但网关是明文 HTTP，等于把控制面暴露到公网，**不推荐**。
