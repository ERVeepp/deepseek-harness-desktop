# DeepSeek Harness Desktop

> 完整开发与运行文档见 [`docs/开发指南.md`](docs/开发指南.md)。

给 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 包一层 Electron 壳的练习项目。

DSH 官方提供 Web UI（`dsh web`），默认跑在 `http://127.0.0.1:3080`。本壳负责：

- **内置 Node.js 运行时** —— 用 Electron 自带的 Node（`ELECTRON_RUN_AS_NODE=1`）执行 DSH 入口脚本，终端用户无需另装 Node。
- **管理官方 DSH 版本** —— 用内置 pnpm 把 npm 包 `@deepseek-ai/dsh` 按版本安装到应用数据目录，升级页面只换版本号，壳代码不动。
- **托管本地进程** —— spawn DSH 子进程、探测就绪、健康检查、异常自动重启、退出时优雅回收。

## 为什么官方页面升级不用改壳

页面本身由 DSH 进程 serve，壳只做一件事：把窗口指向就绪后的 URL。因此官方前端改动对壳零侵入，适配压力全部收敛在「启动 + 进程管理」这条边界上，对应两个模块：

- `src/main/version-manager.ts` —— 版本解析与安装
- `src/main/process-manager.ts` —— 进程 spawn / 就绪探测 / 健康检查 / 重启 / 退出

## 快速开始

```bash
pnpm install
pnpm start
```

首次启动会自动安装 DSH（默认 `latest`），装好后拉起 Web UI。

## 配置（环境变量，前缀 `DSH_DESKTOP_`）

| 变量 | 默认 | 说明 |
|------|------|------|
| `DSH_DESKTOP_VERSION` | `latest` | DSH 版本，如 `0.1.0-rc.6` |
| `DSH_DESKTOP_PORT` | `3080` | Web UI 端口（你本机若用 3000，设 `DSH_DESKTOP_PORT=3000`） |
| `DSH_DESKTOP_NODE_MODE` | `builtin` | `builtin`=Electron 内置 Node；`system`=系统 node |
| `DSH_DESKTOP_NODE` | — | `system` 模式下的 node 路径 |
| `DSH_DESKTOP_PM` | `pnpm` | 安装 DSH 用的包管理器：`pnpm`（内置）/ `npm`（系统） |
| `DSH_DESKTOP_PM_PATH` | — | `npm` 模式或指定系统 pnpm 时的路径 |
| `DSH_DESKTOP_WORKSPACE` | userData/workspace | DSH 工作区目录 |
| `DSH_DESKTOP_NO_RESTART` | — | 设为 `1` 关闭异常自动重启 |

> 若 DSH 在 Electron 内置 Node 下报原生模块（native addon）错误，把 `DSH_DESKTOP_NODE_MODE` 设为 `system` 即可切回系统 Node。

## 目录结构

```
src/
  main/
    index.ts            # 应用入口：窗口、单实例、编排启动
    process-manager.ts  # DSH 进程托管（启动边界核心）
    version-manager.ts  # DSH 版本安装与管理
    node-runtime.ts     # 内置 Node 运行时解析
    config.ts           # 配置读取
    paths.ts            # userData 目录布局
  preload/
    index.ts            # 最小 IPC 桥
  shared/
    types.ts            # 主进程/preload 共享类型
renderer/
  loading.html|css|js   # 启动页（安装/启动进度、错误重试）
```

## 说明

- 仅练习/自用，未接打包（electron-builder）与签名。
- Windows 下子进程退出为强杀（无 POSIX 信号语义），DSH 数据持久化不保证优雅落盘。
