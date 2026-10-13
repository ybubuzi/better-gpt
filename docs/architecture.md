# 架构决策

## 已确认边界

- 名称与位置：better-gpt，`F:/AI_PROJECT/better-gpt`。
- TypeScript/Node.js 业务；当前稳定依赖；Windows/macOS/Linux 为目标平台。
- **用户已更正为纯 TUI/CLI**；先前桌面方案已取消。
- 个人多台电脑使用；每台设备运行本地服务，不建设共享多租户平台。
- 保留 Cloudflare、OpenAI配置；自建支持frp、SSH及external，HTTPS层复用Nginx/Caddy；允许管理外部二进制。
- 项目 A/B/C 可以选择不同提供方；本地 MCP 路径始终为 `/{workspaceUuid}/mcp`。
- 保留旧配置、UUID、能力选择、技能文件及可复用凭据。

## 运行分层

```text
TUI (Ink) / CLI service (Commander)
        │ 本机 named pipe / Unix socket
独立后台 daemon → Application / ConfigStore
        │
工作区核心 ─ MCP 工具与资源 ─ Skills/下游 MCP
        │
TunnelBinding → TunnelProfile → TunnelManager
        ├─ Cloudflare
        ├─ OpenAI
        ├─ frp / SSH + HTTPS反向代理
        └─ 已有外部入口
```

默认 TUI 使用 DaemonClient 连接独立 Node 后台；Application、RuntimeStore、ProcessManager、TunnelManager 属于后台。
q/终端关闭只断开 TUI，后台 MCP、隧道、命令与内存日志继续运行。重开 TUI 读取同一后台。
TUI s 显式启停 MCP/隧道并让管理后台待命；CLI service stop 请求完整 shutdown。
serve 保留前台运行模式，由该 CLI 进程负责服务生命周期。系统服务安装/开机自启仍未实现。
IPC 限制请求大小；状态帧预算8MiB，列表传摘要，选中单条日志/进程时按需传完整详情，客户端处理背压并限制总帧长度。
Unix socket 使用私有目录和0600权限；wx启动锁覆盖遗留socket恢复、绑定与元数据初始化，失败统一回收监听器。
后台初始化中途崩溃遗留的启动锁会明确报错，不通过无锁删除去抢占活跃后台。

## 数据模型

- AppConfig v2：全局 proxy/service、workspaces、tunnelProfiles、skills、downstreamMcps、迁移记录；兼容读取 v1。
- Workspace：稳定 UUID、目录、启停状态、Skills/MCP 选择、Agent 指令、可选绑定。
- Workspace.tunnelEnabled：独立持久化公网入口开关，旧配置默认为true。暂停只影响专用隧道入口，本地MCP仍可调用。
- TunnelProfile：提供方相关字段、凭据引用、启停状态和可选代理覆盖。
- TunnelBinding：profileId。OpenAI新配置在profile保存共享tunnelId；旧绑定中的openAiTunnelId仅为迁移兼容保留。工作区UUID仍随机且独立。
- null 能力名单表示继承全局；空数组表示不选任何能力；迁移中不得合并这两种状态。

当前 config.json 使用严格 schema，未知版本或字段报错，绝不静默覆盖为空配置。
写入使用同目录临时文件、同步和重命名；写锁避免 CLI/TUI 同时覆盖。
异常遗留锁会显式报错，不擅自删除未知进程的锁。

## 隧道与入口

Cloudflare、frp、SSH可多工作区共用连接；OpenAI按用户要求配置一次共享Tunnel ID。OpenAI传输映射一个MCP服务端，后续运行器必须实现明确的多工作区分发，不能默认把所有项目指向第一个工作区；当前运行器仍拒绝启动，未声称该路由已可用。参见[官方Secure MCP Tunnel文档](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。
保存配置不启动进程。每条运行连接必须独立报告启动、就绪、失败、重试和停止状态。

Cloudflare 已使用独立本机入口，监听器固定 profile 身份，再进入共享核心；
入口逐次拒绝未绑定工作区。来自公网的 Host 或自定义 header 不能改变这个 profile。
生成的 ingress 重写 origin Host 为本机入口，允许正确的公网 Origin；主本地入口仍只接受本机 Host/Origin。
Application.startGateway 联动本地服务与 TunnelManager，CLI serve 默认采用此路径；--local-only 保留纯本地模式。
TunnelManager 读取迁移库中的运行凭据，以 TUNNEL_CRED_CONTENTS 环境传递；运行目录只有无密钥 YAML。
cloudflared /ready 的真实状态驱动连接/重连显示，进程意外退出明确失败；t 可重试。
停止先取消启动、停连接器及独立入口，最后关闭主本地服务；运行目录清理失败不阻断资源停止。
Windows 使用现有 Job 封装约束本次连接器进程，旧 Codexter 连接器只做冲突检查，不接管或停止。
Windows 原生连接器也显式加入同一 Job；停止时先清理本次进程树、核验 native PID/创建时间/程序路径，再有限等待退出并关闭管道。
exit 与 close 不再混为一谈，不让继承管道无限阻塞退出。归属文件只记录所有者身份，不含凭据。
Windows 启动恢复只清理已核实为本数据目录、所有者已退出的连接器；活跃其他实例与外部程序不自动停止。
多个Cloudflare profile可并存，但Tunnel ID必须唯一。frp/SSH有独立作用域入口、受管进程、HTTPS身份探测及意外退出重连，重连前重新读取配置。
external使用配置的固定回环端口，连接器由用户管理。OpenAI运行器仍待迁移。TUI/CLI向导共用core校验和原子保存。
范围控制支持项目、profile、提供方和全部。共享连接器直到最后一个启用项目被暂停才停止；按渠道启动不会停止其他渠道。全部启动恢复所有已启用且已绑定项目，包括先前暂停的项目。
startGateway与范围控制按进入顺序协调，范围操作串行处理；停止服务使未完成操作失效，避免停止后旧请求再次启动连接器。公网请求逐次检查当前项目开关。

## 网络

统一 NetworkContext 负责代理选择、认证引用、NO_PROXY、DNS、超时、证书和重试。
提供方可覆盖全局代理。HTTP、HTTPS、SOCKS 代理通过能力适配；
环境变量只能用于明确支持它的外部程序，不能假定覆盖所有进程和 QUIC 连接。
代理失败不静默改为直连；本地回环默认直连。networkFetch覆盖下载器与下游HTTP，支持HTTP/HTTPS/SOCKS代理，区分环境协议及NO_PROXY。
代理凭据由Vault解析，只通过环境/内存传递。frp支持HTTP/SOCKS5，SSH使用内置CONNECT/SOCKS桥接；cloudflared边缘仍是原生网络。

## 实施边界

Windows 本机数据迁移已实现：官方 Hive 内存读取、字段保留、技能文件复制、加密凭据、幂等和回退。
已实现原14个基础工具与workspace_info、Skills选择、STDIO/HTTP下游池、摘要资源/文件变更和对应日志。
文件路径核验真实路径防止目录链接越界，patch预验证并在提交前复检，回滚时保留外部新修改。它不是OS级沙箱，exec仍可运行任意本机命令。
下游池关闭覆盖正在连接的任务；连接与调用超时有界。Computer Use仅在Windows且本机开关启用时发现，逐应用授权不自动批准。
入口认证、完整OAuth交互、OpenAI运行器及其他平台迁移验收仍在roadmap中。
Computer Use 原版依赖 Windows Codex 私有运行时，必须作为独立可选提供方；不能承诺三平台一致。

## 终端工作台

全屏视图以终端实际尺寸布局：左侧工作区和服务状态，右侧标题、日志/终端标签和全高单行列表。
侧栏按高度选择单行紧凑或双行布局，每项目显示渠道与真实连接状态颜色；左下角汇总全部连接。列表显示位置范围，支持工作区搜索、翻页及Home/End，新建/导入后自动选中新增项。
p打开聚焦项目菜单，u打开按渠道控制，t一键启动全部；它们共享后台范围控制API。工作区暂停不能用共享连接器状态代替，已暂停项目即使其共享连接器在线也显示灰色暂停。
Enter 将右侧切为所选记录详情，Esc/Enter 返回原列表位置；详情按稳定 ID 选择，新调用不改变正在查看的记录和滚动。
Tab 在工作区与列表间移动，详情中返回列表；模块和迁移表单有独立输入焦点，防止输入字符触发全局快捷键。
剪贴板适配位于 TUI 层，使用原生系统工具并通过 stdin 传值；URL/Tunnel ID 根据工作区绑定生成。
正常关闭恢复终端原画面。日志过滤不会改变实际调用数据；查看旧记录时可暂停自动跟随。

日志按工作区保留最近 500 条已完成记录，并额外保留 pending 调用及最多 32 条活跃进程原始记录；已完成轮询记录可正常淘汰。
后台进程退出时更新原 exec 调用的状态、退出码与输出，因此无需额外轮询也能显示失败。
SDK 拒绝的未知工具/参数错误在适配层补记；有效调用由 Application 记录，批量请求仅分发一次，每个错误按 JSON-RPC ID 关联。
进程最多同时运行 32 个，历史会话最多 200 个，完成后保留 5 分钟。
显示输出与 MCP 增量读取分别维护缓冲，write_stdin 读取不会清空界面输出。敏感字段和已知环境密钥做基础脱敏，ANSI 控制序列不透传至界面。
Windows 在执行用户命令前建立 Job，普通子进程被纳入同一会话，并监视拥有者进程；POSIX 使用独立进程组。
工作区 cwd 校验不是 OS 沙箱；显式脱离进程组/通过系统服务创建的进程不属于普通命令会话的隔离保证。
Linux/macOS 进程组和界面路径未在本次 Windows 实机验证。

## 技术来源

- [Ink](https://github.com/vadimdemedes/ink)
- [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)
- [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [frp 代理支持](https://gofrp.org/en/docs/features/common/client/)
- [Caddy HTTPS](https://caddyserver.com/docs/quick-starts/https)
