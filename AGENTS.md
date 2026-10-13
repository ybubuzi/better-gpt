# better-gpt 开发约定

- 默认中文交流。项目为纯 TUI / CLI，不引入 Electron、浏览器管理界面或桌面打包。
- `F:/AI_PROJECT/codexter` 是只读的旧实现参考，不改动其代码、配置、凭据或运行进程。
- 默认在 Windows native 环境开发；PowerShell 7、Windows Node。不得混用 Windows/WSL node_modules。
- 使用当前稳定且相互兼容的依赖，锁定版本和 package-lock.json。不使用 nightly 或预发布版本作为默认。
- 先明确行为和验收条件，再实现。除非用户在当前任务明确要求，不新增或扩写自动化测试。
- 采用类型检查、构建、实际 CLI/TUI 操作、日志与协议请求验证；不能把编译成功等同于跨平台验证。
- 核心逻辑不得引用 Ink、React 或终端组件。CLI/TUI 共用 core；输入在 contracts 边界校验。
- 工作区 UUID、`/{uuid}/mcp` 路径、Skills/MCP 选择语义是兼容性契约。
- 隧道配置与工作区绑定分离；运行状态与配置状态分离。允许多个提供方同时存在。
- OpenAI 使用 Tunnel ID；不得构造伪公网 URL。入口必须校验允许工作区，不能只依赖 Host 字段。
- 凭据使用引用；密钥不进入普通 JSON、日志、Git 或 CLI 输出。
- 配置迁移须有备份、预演、校验、幂等和回退；不得直接改写旧 Hive，不得自动重建旧隧道或覆盖 DNS。
- `migration-inspect` 仅查询元数据；`migration preview/import/rollback` 实现数据导入。数据已导入不等于 MCP 工具和隧道运行器已迁移。
- Hive 读取必须走锁定的官方内存 backend；不能以 path 模式打开原库。所有现存字段及原始字节须可在加密归档中恢复。
- 写入新数据前检查目标各级目录，禁止通过 junction/symlink 写入旧目录。技能名称解析必须保留旧版字面语义和来源文件系统大小写规则。
- 工作与验证临时文件放在已忽略的 `work/`。不提交用户实际配置、二进制或缓存。
- 提交前使用 `npm run typecheck` 和 `npm run build`，只运行与改动相关的现有检查。
