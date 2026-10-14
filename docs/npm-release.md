# npm 发布

根包 `better-gpt` 是唯一公开发布的包，内部 `@better-gpt/*` workspace 保持 private。
发布构建将内部代码合并为 ESM，保留 npm 第三方依赖，由目标平台安装其原生模块。
CLI、独立后台、SSH ProxyCommand 和 grep worker 单独生成；不分发当前开发机的 native 二进制。

## 发布前验证

使用 Windows native Node 24.21.0 或以上、npm 11 或以上：

```powershell
npm ci
npm run typecheck
npm run build
npm pack --dry-run
npm pack --pack-destination work
```

`prepack` 自动执行工作区构建及 `build:release`；`prepublishOnly` 在实际发布前执行类型检查。
正式发布前必须将 tarball 安装到仓库外的干净目录，确认没有依赖 workspace 链接：

```powershell
npm install --prefix <独立验证目录> <tarball绝对路径> --omit=dev
& <独立验证目录>\node_modules\.bin\better-gpt.cmd --version
& <独立验证目录>\node_modules\.bin\better-gpt.cmd --help
& <独立验证目录>\node_modules\.bin\better-gpt.cmd --data-dir <临时数据目录> init
& <独立验证目录>\node_modules\.bin\better-gpt.cmd --data-dir <临时数据目录> service start --local-only --port 0
& <独立验证目录>\node_modules\.bin\better-gpt.cmd --data-dir <临时数据目录> service status
& <独立验证目录>\node_modules\.bin\better-gpt.cmd --data-dir <临时数据目录> service stop
```

交互式终端还需检查 TUI 打开、模块切换和退出。仅编译成功不能证明 macOS/Linux 已实测。
迁移 bridge 的源码和锁文件必须出现在 tarball 内；首次导入仍需 Dart 3。缓存按源码指纹、平台和架构区分，在用户数据目录中生成，不写入全局 npm 安装目录。

## 代理

例如本机代理端口 7897：

```powershell
$env:HTTP_PROXY = 'http://127.0.0.1:7897'
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
npm pack --dry-run
npm publish --access public --proxy=http://127.0.0.1:7897
```

不要提交 npm 登录令牌；登录及发布权限由发布者的 npm 账号提供。
应用使用 HTTP、HTTPS 和 SOCKS 专用代理组件，避免通用 PAC/FTP 依赖链中的 [basic-ftp 解析拒绝服务漏洞](https://github.com/advisories/GHSA-c475-qrg2-pj4r)。发布前需检查实际安装 tarball 后的 `npm audit --omit=dev`。

## 发布

```text
npm publish --access public
```

版本号需与 CLI 的 `appVersion` 和内部 workspace 版本同步；已发布的版本不可覆盖。
0.1.0 仍缺少 ChatGPT 连接运行器、CF 完整授权与创建引导、日志持久化及开机自启动安装，发布说明应明确这些限制。

打包机制依据 [npm package.json 文档](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)、[npm 生命周期文档](https://docs.npmjs.com/cli/v11/using-npm/scripts/) 和 [esbuild external/alias 文档](https://esbuild.github.io/api/#packages) 配置。
