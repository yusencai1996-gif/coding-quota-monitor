# 第三方组件

本项目自身代码使用 [MIT License](LICENSE)。第三方组件保留各自许可，项目许可不替代第三方许可。

- **Electron 44.3.0**：MIT；随发行版保留 `app/LICENSE.electron.txt`。
- **Chromium 与 Electron 内含组件**：许可由各组件决定；随发行版保留 `app/LICENSES.chromium.html` 及 Electron 原始发行文件。
- **Acorn 8.18.0**：MIT，用于安全解析服务响应；完整许可打包为 `app/resources/app.asar` 内的 `dist/ACORN-LICENSE.txt`，构建时从安装的依赖复制。
- 开发工具包括 TypeScript、esbuild、electron-builder、Playwright Core 和 Node 类型定义。它们的版本锁定在 `package-lock.json`，许可保留在安装后的各自包目录中；`node_modules` 不作为项目源码或 ZIP 数据目录分发。

平台名称和标识属于各自所有者。本项目不是任何模型服务商的官方产品；使用接口仍须遵守相应服务的条款与账号权限。
