# 自建隧道

Better GPT将公网入口与业务路由分开。Cloudflare、frp、SSH、external可以同时运行，每个入口都有独立的回环监听器，逐次检查工作区绑定；业务URL始终是 `https://域名/{工作区UUID}/mcp`。

## 选择方式

| 方式 | 服务器准备 | 本机准备 | 适用情况 |
| --- | --- | --- | --- |
| frp | frps、认证Token、HTTPS代理、域名和证书 | frpc，程序可按需下载并校验固定发行包 | 常规自建；不需要向应用提供SSH账户 |
| SSH | SSH公钥账户、允许反向转发、HTTPS代理、域名和证书 | OpenSSH、私钥、已核验known_hosts | 已有SSH管理环境；连接器被本机安全软件限制时也可选 |
| external | 自行管理公网HTTP转发 | 任意连接器，目标为专用回环端口 | 已有其他隧道工具或统一网络设施 |

frp支持多协议，当前适配选择TCP，支持HTTP/SOCKS5代理连接frps。参见[官方概览](https://gofrp.org/en/docs/overview/)和[代理设置](https://gofrp.org/en/docs/features/common/client/)。
SSH是可选提供方，并非其他用户的必需条件。应用不会执行任意用户填写的Shell启动脚本。

## 配置与绑定

TUI：`m → 隧道 → n`新建，方向键选择提供方，逐项Enter输入，空格选择工作区，最后确认保存。设置管理页也可进入隧道配置列表选择新建。

CLI：

```text
better-gpt tunnel setup
better-gpt tunnel doctor
better-gpt service start
better-gpt service status
```

SSH常规流程已精简为公网域名、授权发现、选择连接、确认。项目内新建时不重复选择工作区。
授权仅适用于本次发现；选择“不扫描”直接填写私钥绝对路径和`用户名@主机[:端口]`，不会调用发现函数。没有config时按候选密钥文件名显示；有config时优先显示Host别名，并继承用户名、SSH端口、IdentityFile和已知指纹文件。
发现仅解析本机SSH配置和文件元数据，不读取私钥内容，不执行`ssh -G`、`Match exec`或连接远程主机。有限展开SSH目录内的Include，目录外Include及复杂Match会提示核对；不会扫描任意外部目录。
选中别名后，运行时通过原生OpenSSH的`-F`保留所选config，以支持跳板机/代理等连接设置。若别名有自己的代理/跳板机，优先沿用它，避免应用全局ProxyCommand覆盖。手动模式使用`-F none`并显式传递连接参数。

隧道名称按域名或别名自动生成；公网域名同时作为SSH/frps主机默认值。两者可在高级设置分开修改，适用于CDN、反向代理或不同SSH登录主机。端口默认SSH 22、frps 7000；远端回环端口从19080起按本机已保存配置避让，本地external端口从19090起避让，实际服务器占用仍在连接时检查。
高级设置可单独修改名称、主机、端口、密钥、known_hosts、HostKeyAlias及二进制路径，不再强制逐项输入。frp常规只填写域名和Token，external通常只填域名；相同域名已有配置时优先提供直接复用。
保存失败保留当前草稿，可以改高级设置后重试。发现和保存都不会自动信任未知或变更的服务器公钥；没有现存指纹文件时使用应用私有的空known_hosts，首次连接仍需核验并导入公钥。doctor会明确报告空指纹文件。

源码目录使用 `npm run cli -- tunnel setup`。`setup-ssh`保留为SSH向导快捷入口。
向导保存本机配置和工作区绑定，不自动修改任意服务器、DNS或证书。Token隐藏输入并进入系统凭据库保护的加密文件；SSH私钥只引用原路径。
`doctor`不安装依赖、不修改服务器，检查文件、凭据和HTTPS入口身份。没有启动时公网检查失败属于预期状态。
已有工作区选中后会替换其原绑定。同一个配置可以绑定多个工作区，各项目也可绑定不同提供方。

## frps服务端示例

在Linux公网服务器安装与客户端兼容的frps。当前客户端锁定0.70.1，下载来自官方发行，核对SHA256；不使用浮动latest。
将以下配置保存到服务器，例如 `/etc/frp/frps.toml`，自行生成随机认证Token，文件权限仅允许服务账户读取：

```toml
bindAddr = "0.0.0.0"
bindPort = 7000
proxyBindAddr = "127.0.0.1"
auth.method = "token"
auth.token = "REPLACE_WITH_RANDOM_SECRET"
transport.tls.force = true
allowPorts = [{ start = 19080, end = 19180 }]
```

监听7000供frpc连接；映射端口只绑定服务器回环地址，由HTTPS代理发布。每个profile选择一个未占用的remotePort。
不要直接覆盖已有frps配置；核对当前服务和端口后合并。

systemd示例（按实际安装路径修改）：

```ini
[Unit]
Description=frp server
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
```

应用生成frpc配置，Token和认证代理只通过子进程环境传入。系统安全软件拒绝发行包时会明确停止安装，不添加排除项；可选SSH或external。

## SSH服务端准备

使用专门的公钥账户，允许TCP反向转发。应用强制公钥认证、严格主机指纹核对、转发失败退出和保活；远端只监听 `127.0.0.1:remotePort`。
私钥带口令时应先由本机ssh-agent解锁。先通过可信渠道核验主机指纹，写入known_hosts；应用不会自动接受变更的指纹。
`HostKeyAlias`需与known_hosts中的实际记录一致，非默认SSH端口也可配置。

## HTTPS代理

DNS的A/AAAA记录指向服务器。证书需覆盖所选域名，可使用已有有效通配符证书或ACME申请。已有Nginx、Caddy等设施可以复用。
下面示例将公网请求转发到服务器回环19080；修改域名和证书路径后先检查配置，再重新加载：

```nginx
server {
    listen 443 ssl;
    server_name mcp.example.com;
    ssl_certificate /etc/ssl/mcp/fullchain.pem;
    ssl_certificate_key /etc/ssl/mcp/privkey.pem;
    client_max_body_size 4m;
    location / {
        proxy_pass http://127.0.0.1:19080;
        proxy_http_version 1.1;
        proxy_set_header Host 127.0.0.1:19080;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

保持路径不变，不在代理层拼接或删除工作区UUID。不能缓存或缓冲MCP流式响应。
external方式转发到本机配置的 `127.0.0.1:localPort`，并将HTTP Host设为该回环地址。

## 代理与后台

全局代理支持environment/direct/custom，HTTP、HTTPS、SOCKS4/4a/5/5h。下载器和下游HTTP MCP通过同一适配器；环境模式区分HTTP_PROXY/HTTPS_PROXY，遵守NO_PROXY。隧道profile可单独覆盖全局代理。
frpc自身仅支持HTTP/SOCKS5，其他类型会明确报错。SSH通过内置CONNECT/SOCKS适配转发。cloudflared原生边缘连接不能保证遵守环境代理变量。
命令和STDIO MCP获得代理环境；外部工具是否使用代理取决于其自身实现。

`q`只退出TUI，独立后台继续运行。`service stop`明确停止全部本次受管服务。frp/SSH异常退出会重新读取配置，再决定是否重连，已禁用或删除的配置不会复活。
此后台尚未安装为操作系统开机自启服务。

## 当前实际验证

Windows本机与一台自有服务器之间的SSH方案已验证HTTPS回调与工作区隔离。frpc官方Windows发行包被本机安全软件拦截，未绕过防护，因此不把该机器的frp连接记为验收通过。
macOS/Linux客户端尚未实机验证。OpenAI Tunnel ID配置保留，但其运行器仍待迁移。
当前公网MCP没有独立身份认证；绑定隔离用于限制入口范围，不能替代身份认证。工具可执行本机命令，公开给他人使用前应在入口加访问控制，并核对调用方兼容性。
