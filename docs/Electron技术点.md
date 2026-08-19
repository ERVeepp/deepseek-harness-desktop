# Electron 技术点

> 结合 `deepseek-harness-desktop` 实战项目梳理：给 DeepSeek Harness 包一层 Electron 壳。
> 覆盖从三态架构到进程托管、动态依赖安装、打包分发的核心知识点。

---

## 一、三态架构：主进程 / 渲染进程 / preload

Electron 不是单进程应用，而是三种角色分工：

```
┌─────────────────────────────────────────────┐
│  主进程（main）          Node.js 环境          │
│  管窗口、管子进程、管 IPC、访问文件系统        │
│  对应：src/main/index.ts                     │
├─────────────────────────────────────────────┤
│  渲染进程（renderer）    浏览器环境            │
│  只负责展示 UI，不能直接碰 Node/文件系统       │
│  对应：renderer/loading.html                 │
├─────────────────────────────────────────────┤
│  preload（桥）          受限 Node 环境         │
│  主进程和渲染进程之间的安全桥，暴露白名单 API   │
│  对应：src/preload/                          │
└─────────────────────────────────────────────┘
```

**核心原则**：主进程和渲染进程不能共享变量，只能靠 IPC 通信。

---

## 二、IPC 进程间通信

```
渲染进程 → ipcRenderer.send('channel', data)
                ↓
主进程   → ipcMain.on('channel', handler)

主进程   → webContents.send('channel', data)
                ↓
渲染进程 → ipcRenderer.on('channel', handler)
```

**DSH 实战**：主进程把 DSH 运行状态（idle/starting/ready/crashed）通过 IPC 广播给渲染进程，加载页据此展示"启动中 / 就绪 / 异常"。

```typescript
// 主进程：状态变更时广播
mainWindow.webContents.send('dsh:status', state)

// 渲染进程：监听状态
ipcRenderer.on('dsh:status', (_e, state) => { ... })
```

---

## 三、安全模型：contextIsolation + sandbox

Electron 历史上最大的安全问题是"渲染进程能直接跑 Node"，一旦页面被 XSS 就能拿到系统权限。

```
现代安全三件套：
  ① contextIsolation: true    → preload 与页面 JS 隔离，互不可见
  ② sandbox: true             → 渲染进程沙箱化
  ③ nodeIntegration: false    → 页面禁用 Node（默认已禁）
```

**要点**：页面 JS 只能通过 preload 暴露的白名单 API 访问系统能力，preload 用 `contextBridge.exposeInMainWorld` 暴露。

---

## 四、内置 Node 运行时（ELECTRON_RUN_AS_NODE）

**这是 DSH 项目最核心的技术点**：让终端用户免装 Node。

### 原理

```
Electron 打包后自带一份 Node.js（塞在 electron.exe 里）

electron.exe 平时是浏览器壳
     │
     │ 环境变量 ELECTRON_RUN_AS_NODE=1
     ▼
electron.exe 退化成纯 Node 解释器：
  electron.exe script.js  ≈  node script.js
```

### 实战代码（node-runtime.ts）

```typescript
// 内置模式：process.execPath 是当前 electron.exe 的路径
function resolveNodeRuntime(mode) {
  if (mode === 'system') {
    return { execPath: nodePath ?? 'node', builtin: false }
  }
  // 内置模式：把 electron.exe 当 node 用
  return { execPath: process.execPath, builtin: true }
}

// spawn 时带上环境变量
spawn(execPath, [script, ...args], {
  env: builtin ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
})
```

### 为什么留 system 模式

DSH 可能带原生插件（native addon，如 pty 终端），这类插件对 Node ABI 版本敏感。Electron 内置 Node 跑不动时，可切回用户自装的系统 Node。

---

## 五、子进程托管（进程生命周期管理）

**这是"壳"的适配压力核心**。DSH 是个长驻 Web 服务，壳要负责它的生老病死。

```
spawn 拉起 → 就绪探测 → 健康检查 → 异常重启 → 优雅退出
```

### 5.1 就绪探测（比"盲等几秒"可靠）

DSH 启动成功后会往 stdout 打印 `dsh web: http://127.0.0.1:<port>`。

```
不断收集子进程 stdout → 正则匹配这行 → 匹配到即认为就绪
```

```typescript
child.stdout.on('data', (chunk) => {
  output += chunk.toString()
  const m = output.match(/http:\/\/127\.0\.0\.1:(\d+)/)
  if (m) resolve(`http://127.0.0.1:${m[1]}`)
})
```

### 5.2 健康检查（发现"端口死了但进程还活着"）

```
就绪后每隔几秒向 http://127.0.0.1:<port> 发 GET
能收到任何响应（哪怕 404）→ 服务还活着
真正的崩溃由 child 'exit' 事件兜底
```

### 5.3 异常重启（带退避，防重启风暴）

```
子进程意外退出 → 自动拉起
  ├─ restarts 计数，超过上限停止
  ├─ 退避延迟：连续崩溃时拉长间隔
  └─ stopping 标志区分「自己关」和「异常退出」
```

**关键**：`stopping` 标志是防误重启的核心——用户主动关闭时置 true，`exit` 事件据此判断是否要重启。

### 5.4 优雅退出（防孤儿进程）

```
app 关闭（will-quit）→ 杀掉 DSH 子进程 → 等待 exit → 才真正退出
否则用户关了壳，DSH 进程还残留后台占着端口
```

---

## 六、动态依赖安装（版本管理）

**DSH 项目第二个核心点**：官方升级只改版本号，壳代码不动。

### 思路

```
官方 DSH 是 npm 包 @deepseek-ai/dsh

按版本号装到独立目录，每个版本一个沙盒：
  versions/
    ├── 0.1.0-rc.6/
    │   └── node_modules/@deepseek-ai/dsh/
    └── 0.1.0-rc.7/
        └── node_modules/@deepseek-ai/dsh/

升级 = 装新版本到新目录 + 改一个版本字符串
回退 = 指向旧版本目录
```

### 关键技术点

```typescript
// npm install --prefix 把依赖装到指定目录
spawn('npm', ['install', `${PKG}@${version}`, '--prefix', installDir])

// 读 package.json 的 bin 字段找入口脚本
// @deepseek-ai/dsh 的 bin 是 { dsh: "lib/bin.js" }
const pkg = JSON.parse(readFileSync(pkgJson))
const binRel = pkg.bin.dsh          // → "lib/bin.js"
const binPath = path.join(pkgDir, binRel)
```

**注意**：`--prefix` 是让 `npm install` 把目标目录当项目根，依赖装到 `<目录>/node_modules`，这样不同版本互不干扰。

---

## 七、单实例锁（requestSingleInstanceLock）

DSH 占用固定端口，若允许多开，第二个实例会因端口被占而失败。

```typescript
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()  // 已有实例在跑，本实例退出
} else {
  // 用户再次双击图标：不新开实例，聚焦已有窗口
  app.on('second-instance', () => {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
}
```

---

## 八、打包分发（electron-builder）

```
pnpm run dist  → 产出 release/ 下的 exe 安装包
```

### 关键配置

```json
{
  "build": {
    "files": ["dist/**/*", "renderer/**/*", "package.json"],
    "asarUnpack": ["node_modules/pnpm/**"],
    "win": { "target": ["nsis"] },
    "nsis": { "oneClick": false }
  }
}
```

| 配置 | 作用 |
|------|------|
| `files` | 只打包必要文件，瘦身 |
| `asarUnpack` | 把 pnpm 解包——pnpm 需要在真实文件系统跑，不能放在 asar 压缩包内 |
| `nsis.oneClick` | false = 用户可选安装目录 |

### asar 是什么

Electron 默认把应用代码打包进 `app.asar` 压缩归档（加快加载 + 防篡改）。但**需要以真实路径执行的二进制/脚本**（如 pnpm.cjs、native addon）必须 `asarUnpack` 解包出来。

---

## 九、生命周期与资源清理

```
app.whenReady()        → 创建窗口、装版本、起进程
window-all-closed      → 非 macOS 直接退出
will-quit              → 清理 DSH 子进程（防孤儿进程）
second-instance        → 聚焦已有窗口
```

**核心坑点**：`will-quit` 里清理子进程要防循环触发——加 `cleanedUp` 标志，避免反复进清理逻辑。

---

## 十、DSH 项目的技术点速查表

| 技术点 | 对应文件 | 核心知识点 |
|--------|----------|-----------|
| 三态架构 | index.ts | 主进程/渲染/preload 分工 |
| 单实例锁 | index.ts | requestSingleInstanceLock |
| 内置 Node | node-runtime.ts | ELECTRON_RUN_AS_NODE |
| 进程托管 | process-manager.ts | spawn + 就绪探测 + 健康检查 + 重启 + 优雅退出 |
| 版本管理 | version-manager.ts | npm install --prefix + bin 字段解析 |
| IPC 广播 | index.ts + preload | ipcMain/webContents.send 状态推送 |
| 打包 | package.json build 字段 | asarUnpack、nsis |

---

## 面试高频问题（对照答案）

**Q：怎么让 Electron 应用免装 Node？**
A：`ELECTRON_RUN_AS_NODE=1` 时 electron.exe 退化成 Node 解释器，用 `process.execPath` 当 node 用。

**Q：怎么可靠地知道子进程服务就绪了？**
A：不盲等几秒，而是收集子进程 stdout，正则匹配就绪标志行。

**Q：子进程异常退出怎么处理？**
A：`exit` 事件 + `stopping` 标志区分主动/异常，异常时带退避重启，上限停止。

**Q：怎么让官方依赖升级不改壳代码？**
A：`npm install --prefix` 按版本装到独立目录，壳只改版本字符串。

**Q：asarUnpack 是干什么的？**
A：把需要真实文件系统路径执行的二进制/脚本从 asar 解包出来，如 pnpm.cjs。
