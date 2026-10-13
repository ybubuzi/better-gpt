# 功能迁移状态

此清单描述完整产品目标，不能将工程初始化视为完整迁移完成。

| 模块 | 当前状态 | 未完成内容 |
| --- | --- | --- |
| 工程与依赖 | 已建立 | 三平台 CI、分发产物 |
| TUI | 全屏分栏、日志/终端、模块切换、焦点/翻页/筛选、迁移向导 | 完整编辑配置界面、鼠标操作 |
| CLI | service start/status/stop，前台serve及配置命令 | 全功能配置命令、系统服务安装及开机自启 |
| 工作区 | 新增后绑定、读取、解绑/换绑、删除管理记录、独立公网开关、UUID稳定及校验 | 名称目录编辑、能力选择界面 |
| MCP | HTTP SDK、原14基础工具、workspace_info、资源和摘要UI；实际插件调用通过 | 更广兼容场景与三平台验收 |
| 本地工具 | read/read_image/apply_patch/ls/grep/glob/code_explore/exec_command/write_stdin | 三平台实机验收 |
| Skills | 数据/目录迁移、选择语义、skills_list/skill_read | 编辑管理、关联来源、监听 |
| 下游 MCP | 加密导入、STDIO/HTTP连接发现重连、mcp_tools/mcp_call；node_repl实际通过 | 完整OAuth交互；现有GitLab凭据401需恢复授权 |
| summary 与日志 | summary、净文件差异、摘要UI、后台内存记录及错误筛选 | 日志持久化及导出 |
| 后台运行 | 独立Node后台、本机IPC、TUI退出后服务继续、明确停止与有界连接器清理 | Windows Service/systemd/launchd安装、开机自启、其他平台实机验证 |
| 多隧道 | Cloudflare/frp/SSH受管生命周期，external独立端口；CF和SSH同时公网通过 | tunnel-client运行器、入口认证、跨机并发检查；本机frpc被安全软件拦截未实测 |
| 自建服务器 | frp/SSH/external TUI与CLI向导、doctor、部署说明；DNS/Nginx/SSH公网回调通过 | 通用服务端自动部署与证书生命周期管理 |
| 代理 | 下载/HTTP下游、认证凭据、命令环境、SSH CONNECT/SOCKS、frp HTTP/SOCKS5 | cloudflared原生边缘代理能力限制；三平台实机验证 |
| 旧配置迁移 | Windows 本机预览/导入/校验/加密备份/幂等/回退已实现 | macOS 实机验收、Linux 凭据导出、跨机迁移包 |
| Computer Use | Windows可选helper自动发现、14工具、截图身份和逐应用授权；隔离只读观察通过 | 真实鼠标/键盘操作验收；其他平台不承诺一致 |
| 环境诊断与更新 | tunnel doctor，frpc固定版本SHA256校验及受代理下载 | 通用检查修复、其他二进制下载、CLI更新 |

实现按“旧数据兼容与核心契约 → 工具与能力 → 代理与隧道 → 完整 TUI → 三平台验收”推进。
公网运行必须同时具备入口访问控制和工作区范围限制。
