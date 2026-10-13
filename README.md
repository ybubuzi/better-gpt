# better-gpt

通过 **TUI / CLI** 管理本地 MCP 服务、工作区和独立隧道绑定。
面向个人多台电脑，目标平台为 Windows、macOS、Linux。没有桌面客户端或浏览器界面。

## 当前交付范围

这是可运行的迁移版本，Codexter的14个基础工具已经接入；完整产品仍有待迁移项，见功能清单。

- 全屏 Ink 工作台：左侧工作区，右侧以单行调用列表为主；Enter 按需打开详情，Esc/Enter 返回列表。
- 工作区 MCP 地址复制：c 复制公网 URL、本地 URL 或 OpenAI Tunnel ID；系统剪贴板写入有成功/失败提示。
- 错误调用记录：未知工具、错误参数、执行异常、非零退出和后台进程失败均有状态与详情，e 仅看异常。
- 配置面板：新增/选择工作区、保存代理配置，选择来源、预览并确认迁移。
- CLI：初始化、状态查询、工作区创建、隧道配置保存、绑定和路由预览。
- 独立本地 MCP 服务：`/{workspace-uuid}/mcp`，提供原版14个基础工具及额外的`workspace_info`。
- 命令调用和进程输出使用真实数据；进程面板显示会话、命令、耗时、退出码，可确认结束进程。
- 配置版本校验、原子写入、并发写锁、重复标识与无效绑定校验。
- Cloudflare / OpenAI / frp / SSH / 已有外部隧道的数据模型可并存。
- Cloudflare 运行器：使用已迁移的程序与加密凭据、独立工作区入口、就绪探测、重连状态、连接器日志和停止清理。
- 独立后台服务：TUI 连接后台控制入口，q 只退出界面；重新打开恢复状态和后台内存日志。CLI 可启动、查看、停止后台。
- Codexter 本机数据导入：官方 Hive 内存解码、原 UUID/字段保留、技能文件复制、凭据加密、重复导入去重和受保护回退。

- 文件工具：read/read_image/apply_patch/ls/grep/glob/code_explore；命令工具exec_command/write_stdin；能力工具skills_list/skill_read/mcp_tools/mcp_call；回合summary及原摘要资源。
- STDIO/HTTP下游MCP连接、重连、能力选择、错误记录；Windows可选Computer Use helper自动发现及明确应用授权。
- 自建frp/SSH运行器、官方frpc发行校验、认证代理适配；TUI/CLI自建向导、专用入口及只读诊断，见[自建说明](docs/self-hosted.md)。
- SSH简化向导：先授权再发现`.ssh`别名/候选密钥，自动继承端口与用户；支持拒绝扫描后手动填写。名称和端口等收进高级设置，域名默认兼作主机地址；TUI/CLI共用默认值。

尚未实现：OpenAI运行器、全部配置编辑界面、日志持久化、完整OAuth交互和系统开机自启动安装。
已配置的隧道不会被显示为已连接。命令子进程会继承对应代理环境；这不代表所有外部程序都会使用代理。

## 开发环境

2026-10-13 从官方 npm registry 核对并锁定：

| 技术 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | 24.21.0 LTS 基线 | Windows native 开发；其他系统使用本机 Node |
| TypeScript | 7.0.2 | 严格类型检查与编译 |
| Ink | 8.0.0 | 终端渲染 |
| React | 19.3.0 | Ink 的组件模型，无浏览器依赖 |
| Ink UI | 2.0.0 | 终端选择与文本输入 |
| MCP Server SDK | 2.3.1 | 官方 MCP 实现 |
| MCP Node adapter | 2.1.1 | Node HTTP 适配 |
| Zod | 4.6.7 | 配置与输入校验 |
| Commander | 15.0.0 | CLI 命令 |

npm 基线为本机 11.19.0；锁文件提交到仓库。使用当前 Node LTS，而不为了追版本切换全局运行时。
独立缓存位于 `work/npm-cache`，不修改用户全局 npm 缓存或 registry。

```powershell
cd F:\AI_PROJECT\better-gpt
npm ci
npm run build
npm start
```

`npm start` 先构建当前源码，再在当前终端打开全屏 TUI，避免运行过期界面；退出后恢复原终端画面。
TUI 默认连接独立后台：按 s 启动 MCP 与隧道，按 q 或 Ctrl+C 只退出管理界面，后台继续工作。
再次打开会连接同一后台，恢复工作区状态、调用记录和运行进程。明确停止服务才会关闭 MCP、隧道及其受管命令。
这与前台 `serve` 不同：`serve` 的 Ctrl+C 会结束该前台实例。

| 按键 | 操作 |
| --- | --- |
| Tab / Shift+Tab | 在工作区和记录列表间切换；详情中返回列表 |
| ↑↓ / Enter | 选择工作区或记录，进入详情 |
| Esc / Enter（详情中） | 关闭详情并返回原列表位置 |
| c | 复制聚焦工作区的 MCP URL / OpenAI Tunnel ID |
| 1 / 2 | 实时日志 / 运行终端 |
| / / e | 侧栏搜索工作区；右侧筛选调用 / 仅看异常 |
| PgUp / PgDn、Home / End | 工作区和列表翻页、跳至首尾；详情滚动 |
| f | 恢复跟随新调用或进程输出 |
| x | 确认结束选中的运行进程 |
| m | 工作区、Skills、MCP、隧道、迁移、设置之间切换 |
| n / r | 新建工作区 / 刷新配置并尝试重连后台 |
| s | 联动启停后台 MCP 和已绑定隧道；管理后台保持待命 |
| p | 聚焦项目菜单：绑定/换绑、解绑、启停、复制地址、删除管理记录 |
| u | 按Cloudflare、自定义、ChatGPT或全部范围启停公网入口 |
| t | 一键启动 / 恢复全部已启用工作区的公网入口，包含已单独暂停的项目 |
| ? / q | 查看帮助 / 退出管理界面，服务继续运行 |

80×24 与 120×36 原生 Windows 终端已验证。72 列以下折叠侧栏为工作区选择视图；最低 60×18。
较矮终端使用单行工作区列表，名称旁显示渠道和连接状态颜色；较高终端显示两行及状态文字。绿色已连接、黄色连接中/重连/外部未验证、红色失败、灰色暂停/未启动/未绑定；左下角汇总所有隧道。
侧栏显示可见范围，支持搜索与首尾跳转。新建/导入后自动选中新工作区；名称未显示时可在侧栏按`/`搜索，或按End到末尾。
单项目公网开关与本地MCP独立，暂停不会停止本地工具。共享同一隧道的其他工作区继续运行；最后一个项目暂停才停止该连接器。暂停状态保存在配置中；全部启动会恢复已暂停项目。
新建项目后直接选择：CF、ChatGPT、已有自建隧道名称、新建SSH/frp。CF/ChatGPT仅首次填写共享配置；已有自建隧道直接复用。ChatGPT的`tunnel_…`是隧道配置编号，与每项目独立随机生成的UUID不同。
解绑和删除项目都保留共享隧道配置。删除需在项目菜单确认，只移除管理记录并停止该项目的受管进程，不删除磁盘文件。运行中换绑立即撤销旧入口并接入新入口，同一配置的其他项目不受影响。
终端面板沿用 Flutter 的受管进程输出模式，不是用于 vim 等全屏程序的 PTY 模拟器。
TUI 的日志来自所连接的后台。退出/重开 TUI 不清空日志；后台退出后，其内存日志清空。
不会读取旧 Flutter 或另一独立 `serve` 前台实例的内存日志；日志持久化与导出仍未实现。
详情固定所选记录；收到新调用时，正在查看的详情与滚动位置不切换。列表支持异常筛选与分页。
Windows 使用原生系统剪贴板，macOS 使用 pbcopy，Linux 需要图形会话以及 wl-copy、xclip 或 xsel。
仅本地工作区需先启动服务，复制实际监听端口的地址；公网绑定复制已配置的 URL，并不代表隧道连通性已验证。
本地开发服务默认端口 18921；可用 `BETTER_GPT_PORT` 指定 TUI 端口，0 表示分配空闲端口。

也可在本项目目录使用 `npx --no-install better-gpt`，无需全局安装。
非交互式终端必须使用明确的 CLI 子命令；不会尝试进入 TUI。

```powershell
npm run cli -- --help
npm run cli -- init
npm run cli -- workspace add --name "项目 A" --path "F:\MY_PROJECT"
npm run cli -- status
npm run cli -- service start
npm run cli -- service status
npm run cli -- service stop
npm run cli -- serve --port 18921
npm run cli -- serve --port 18921 --local-only
npm run cli -- migration-inspect
npm run typecheck
```

开发入口 `npm run dev` 会编译共享包，再通过 tsx 运行 CLI。它不会自动重启服务进程。

`service start` 启动独立后台并联动已绑定隧道，命令返回后服务继续运行；可加 `--local-only`、`--profile`、`--port`。
`service status` 查询实际后台状态；`service stop` 停止 MCP、隧道和受管进程，并退出后台进程。
本地控制使用 Windows named pipe / Unix socket，不开放公网管理 URL；多个 TUI 连接同一个数据目录的后台。
当前实现为独立后台进程，不安装 Windows Service、systemd unit、launchd 或开机自启动项。
更新源码后需在适当时机重启后台进程，已运行的 Node 不会自动加载新的构建文件。

Windows 停止连接器时清理本次进程树并设有界等待，原生连接器显式加入 Job。
启动会核对连接器归属；本应用所有者已退出的 Windows 孤儿可安全恢复，活跃其他实例和外部连接器只报告冲突。
若在后台初始化中途强杀导致 `runtime/startup.lock` 遗留，会明确报告锁路径；确认记录的进程已退出后处理，不自动覆盖未知所有者的锁。

## 数据目录

- Windows：`%APPDATA%/better-gpt`
- macOS：`~/Library/Application Support/better-gpt`
- Linux：`$XDG_DATA_HOME/better-gpt`，未配置时为 `~/.local/share/better-gpt`
- 覆盖：`BETTER_GPT_DATA_DIR`，或 CLI 全局选项 `--data-dir`。

新项目不写入 `codexter` / `codexter-dev` 数据目录。
`migration-inspect` 只读取已知文件的存在性和大小，不解析 Hive、不读取系统密钥、不启动迁移。

## 导入旧版数据

在 TUI 选择“迁移” → 旧数据目录 → 查看预览 → “确认备份并导入”。支持上下键、Enter 和 Esc。
完成后可查看导入的工作区；重复导入同一快照不会创建重复记录。
Windows 本机迁移已实测，macOS 凭据读取路径尚未实机验证；Linux 来源的系统凭据迁移暂不支持。

首次迁移需要 Dart 3 来构建一次性的 Hive 2.2.3 兼容工具，TUI 会自动准备；也可手动运行：

```powershell
npm run migration:build
npm run cli -- migration preview --source "$env:APPDATA\codexter"
npm run cli -- migration import --source "$env:APPDATA\codexter" --fingerprint <预览中的fingerprint>
npm run cli -- migration rollback <最近一次迁移ID>
```

常规 TUI/CLI 不依赖 Flutter。兼容工具只从管道中的内存快照读取 Hive，不打开旧数据库路径或执行恢复。
新配置使用 schemaVersion 2，可读取版本 1。旧全局字段和完整原始文件进入加密归档；密钥由系统凭据库保护。
迁移后用户修改了配置时，自动回退会拒绝覆盖这些修改。
导入不会启动或接管旧隧道。数据导入完成不等于原版工具和下游 MCP 运行功能已全部迁移。

## 多隧道配置

在 `examples/` 中提供不含真实凭据的配置示例。导入时可以省略 `id`，系统自动生成。
`credentialRef` / `runtimeKeyRef` 是凭据引用，**不是令牌内容**。迁移生成的 `vault:` 引用使用系统密钥库和 AES-GCM 保存；示例中的引用仅为占位。

```powershell
npm run cli -- tunnel add --file examples/cloudflare.profile.json
npm run cli -- tunnel add --file examples/openai.profile.json
npm run cli -- tunnel add --file examples/frp.profile.json
npm run cli -- workspace bind --workspace <工作区UUID> --profile <隧道配置UUID>
npm run cli -- workspace bind --workspace <工作区UUID> --profile <OpenAI配置UUID> --tunnel-id <TunnelID>
npm run cli -- tunnel plan
```

`tunnel plan` 只显示路由计划，不会启动 cloudflared、tunnel-client 或 frpc。

按范围控制后台公网入口（不停止本地MCP）：

```text
better-gpt tunnel start --all
better-gpt tunnel start --provider cloudflare
better-gpt tunnel start --provider custom
better-gpt tunnel stop --workspace <UUID>
better-gpt tunnel start --workspace <UUID>
better-gpt tunnel stop --profile <UUID>
```

custom包括frp/SSH/external，也支持分别指定这三个提供方。按渠道启动保留其他渠道的连接。OpenAI运行器尚未实现，配置菜单中的ChatGPT操作会如实报告运行器缺失。

导入后按 `s` 或运行 `serve`，默认联动启动已启用、已绑定工作区的 Cloudflare 隧道。
运行凭据从新数据目录的加密库读取，通过子进程环境传递，不写入参数或生成的 YAML。
程序依据实际监听端口生成新运行配置，保留原域名与 `/{uuid}/mcp`，不重建 Tunnel、不修改 DNS。
各 Cloudflare 配置使用独立回环入口，入口逐次检查工作区绑定；同一个 Tunnel ID 不能配置为两个 profile。
`--local-only` 明确只启动本地服务，`--profile <UUID>` 只启动该配置及其工作区。

旧 Codexter 的相同隧道仍在运行时，新程序会拒绝重复连接并显示原因；先在旧程序中停止服务，再按 `t` 重试。
这是为了避免 Cloudflare 将请求分配到新旧两个功能不同的后端。新程序不会杀掉旧进程。
在 `m → 隧道` 查看连接器日志和错误；“已连接”表示 cloudflared 就绪端点确认存在边缘连接，不等于已完成域名 DNS/Access 与所有旧工具的验收。
OpenAI配置目前会明确报告运行器尚未接入；external配置启动专用回环入口，连接器由用户管理，公网身份可用`tunnel doctor`检查。

代理环境会传递给 cloudflared，但其边缘连接使用原生 QUIC/HTTP2 网络，不能把 HTTP/SOCKS 环境变量当成已代理边缘流量。
该限制在隧道日志中显示；下载与下游HTTP走统一代理适配，frp仅接受HTTP/SOCKS5代理，SSH使用CONNECT/SOCKS适配。
同一Cloudflare、SSH、frp或外部配置可绑定多个工作区。新ChatGPT配置将共享Tunnel ID存放在profile，项目绑定不再填写独立ID；旧版项目ID字段继续保留兼容。ChatGPT运行器和共享入口的项目路由尚未接入，不把配置完成视为连接可用。
公网入口使用 `https://域名/{uuid}/mcp`，OpenAI 对外使用 Tunnel ID，本地路径仍为 `/{uuid}/mcp`。

本地`serve --profile <UUID>`可以验证工作区允许名单，只监听127.0.0.1。各受管隧道使用独立入口，并校验绑定及Host/Origin；公网MCP独立身份认证仍待实现，入口范围限制不能替代鉴权。

## 下载代理

安装依赖可以继承现有代理环境。需要手动设置时，例如：

```powershell
$env:HTTP_PROXY = 'http://127.0.0.1:7890'
$env:HTTPS_PROXY = 'http://127.0.0.1:7890'
npm ci
```

不要把账号、密码或 token 写入仓库 `.npmrc`。
应用代理模型区分 environment/direct/custom，接受 HTTP、HTTPS、SOCKS4/4a/5/5h 地址。
新命令进程已注入对应代理环境及本机绕过规则；认证信息通过加密凭据引用解析。下载器与下游HTTP MCP支持统一代理，环境模式遵守目标协议及NO_PROXY。
外部命令是否遵守代理变量取决于其自身实现；cloudflared原生边缘连接不保证走这些代理。

## 代码结构

```text
apps/
  cli/                 命令解析、交互入口、前台服务
  tui/                 Ink 终端界面
packages/
  contracts/           版本化配置、校验、工作区地址模型
  core/                配置存储、工作区、MCP 入口、路由计划、数据迁移、凭据库
tools/
  legacy-hive/         一次性只读 Hive 兼容工具
docs/
  architecture.md      已确认设计与边界
  migration.md         旧配置无损迁移契约
  roadmap.md           功能迁移清单
  verification.md      本次实际验证结果
examples/              不含凭据的隧道配置示例
```

不新增自动化测试作为本次初始化内容；验证采用类型检查、构建、实际 CLI/TUI 操作和 HTTP 调用。
