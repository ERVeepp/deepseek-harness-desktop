import { app, BrowserWindow, ipcMain, shell } from 'electron'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { getPaths } from './paths'
import { loadConfig } from './config'
import { resolveNodeRuntime } from './node-runtime'
import { VersionManager } from './version-manager'
import { ProcessManager } from './process-manager'
import type { DshState } from '../shared/types'

/**
 * index.ts —— Electron 主进程入口（整个应用的「大脑」）
 *
 * 【主进程 vs 渲染进程】
 * Electron 有两个进程：
 *   - 主进程（本文件）：跑 Node，管窗口、管 DSH 子进程、管 IPC；
 *   - 渲染进程（renderer/loading.html）：跑网页，只负责展示 UI。
 * 两者靠 IPC（ipcMain / ipcRenderer）通信，不能直接共享变量。
 *
 * 本文件负责「编排」：创建窗口 → 装版本 → 起进程 → 窗口跳转到 DSH 页面。
 * 具体实现都下沉到 version-manager / process-manager 两个模块，
 * 入口只做调用串联，所以官方 DSH 怎么升级，这里基本不用改。
 */

/** 主窗口引用 */
let mainWindow: BrowserWindow | null = null
/** 当前运行状态（会被广播给渲染进程） */
let state: DshState = { status: 'idle', restarts: 0 }
/** DSH 进程托管器 */
let processManager: ProcessManager | null = null
/** DSH 版本管理器 */
let versionManager: VersionManager | null = null
/** 退出清理是否已完成（防止 will-quit 循环触发） */
let cleanedUp = false

/**
 * 【单实例锁】
 * requestSingleInstanceLock 保证同一时间只有一个应用实例在跑。
 * 因为 DSH 会占用固定端口，若允许开多个实例，第二个会因为端口被占而失败。
 * 抢不到锁说明已有实例在跑，本实例直接退出，并把焦点交给已有实例。
 */
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // 用户再次双击图标时触发：不新开实例，而是聚焦已有窗口
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  // Electron 初始化完成后的入口
  app.whenReady().then(() => {
    mainWindow = createWindow()

    // 注册 IPC：渲染进程通过这些通道与主进程交互
    ipcMain.handle('dsh:get-state', () => state) // 拉取状态快照
    ipcMain.on('dsh:restart', () => {
      void restart() // 手动重启 DSH
    })
    ipcMain.on('dsh:quit', () => app.quit()) // 退出应用

    void start() // 开始启动编排
  })

  // 所有窗口关闭时退出应用（macOS 习惯是保留在 Dock，所以 darwin 不退出）
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  /**
   * 【退出前回收子进程】
   * app.quit() 会先触发 before-quit、will-quit 再真正退出。
   * DSH 子进程是独立进程，不会随主进程自动死掉，必须手动 kill，
   * 否则会留下孤儿进程继续占端口。
   * 回收是异步的，所以先 event.preventDefault() 挂起退出，
   * 等子进程停干净再重新 app.quit()（此时 cleanedUp=true，放行）。
   */
  app.on('will-quit', (event) => {
    if (cleanedUp || !processManager) return
    event.preventDefault()
    const pm = processManager
    processManager = null
    void pm.stop().finally(() => {
      cleanedUp = true
      app.quit()
    })
  })
}

/** 创建主窗口：先加载本地启动页，就绪后再由主进程切到 DSH 地址 */
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'DeepSeek Harness',
    webPreferences: {
      // 预加载脚本路径：编译后位于 dist/preload/index.js
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true, // 隔离渲染进程与 preload 的 JS 上下文（安全）
      nodeIntegration: false, // 渲染进程禁用 Node（安全）
    },
  })
  win.setMenuBarVisibility(false) // 隐藏菜单栏，更接近 App 观感
  // DSH 页面里可能弹外链，一律交给系统浏览器打开，不在应用内新开窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.on('closed', () => {
    mainWindow = null
  })
  return win
}

/** 合并状态并广播给渲染进程 */
function setState(partial: Partial<DshState>): void {
  state = { ...state, ...partial }
  mainWindow?.webContents.send('dsh:state', state)
}

/** 内置 pnpm 的入口脚本路径（打包后需指向 asar.unpacked 的真实文件） */
function bundledPnpmScript(): string {
  if (app.isPackaged) {
    // 打包后 pnpm 通过 asarUnpack 解包到 app.asar.unpacked，
    // 否则 Electron 内置 Node 无法在 asar 内执行 pnpm.cjs
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  }
  return path.join(app.getAppPath(), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
}

/** 启动页本地文件路径 */
function loadingPage(): string {
  return path.join(app.getAppPath(), 'renderer', 'loading.html')
}

/** 启动编排：装版本 → 起进程 → 窗口跳转 */
async function start(): Promise<void> {
  const config = loadConfig()
  const paths = getPaths()
  // 确保工作区目录存在（DSH 进程的 cwd）
  await fsp.mkdir(paths.defaultWorkspace, { recursive: true })
  const workspaceDir = config.workspaceDir || paths.defaultWorkspace
  versionManager = new VersionManager(
    paths.versionsRoot,
    config.pm,
    config.pmPath,
    resolveNodeRuntime('builtin'), // 内置 pnpm 固定用 Electron 内置 Node 执行
    bundledPnpmScript(),
  )

  // 回到启动页，展示安装/启动进度
  void mainWindow?.loadFile(loadingPage())

  try {
    // 1. 安装/解析 DSH 版本（latest 会先查版本号再装）
    setState({ status: 'installing', lastLog: undefined, message: undefined, url: undefined })
    const install = await versionManager.ensure(config.dshVersion, (line) => setState({ lastLog: line.trim() }))
    setState({ version: install.version })

    // 2. 创建进程托管器并启动 DSH
    processManager = new ProcessManager({
      binPath: install.binPath,
      runtime: resolveNodeRuntime(config.nodeMode, config.nodePath),
      dshHome: paths.dshHome,
      host: config.dshHost,
      port: config.dshPort,
      workspaceDir,
      readyTimeoutMs: config.readyTimeoutMs,
      healthIntervalMs: config.healthIntervalMs,
      maxRestarts: config.maxRestarts,
      autoRestart: config.autoRestart,
      onLog: (line) => {
        console.log('[dsh]', line) // 同步打到终端，便于调试
        setState({ lastLog: line })
      },
      onStatus: (status, message) => {
        console.log('[dsh]', status, message ?? '')
        setState({ status, message })
        // 出错时切回启动页，展示错误和重试按钮
        if (status === 'error') {
          void mainWindow?.loadFile(loadingPage())
        }
      },
      // 3. 就绪后把窗口从启动页跳转到 DSH 的 Web UI
      onReady: (url) => {
        setState({ status: 'ready', url })
        void mainWindow?.loadURL(url)
      },
    })
    await processManager.start()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[dsh] error:', message)
    setState({ status: 'error', message })
  }
}

/** 手动重启：先停旧进程，再走一遍启动编排 */
async function restart(): Promise<void> {
  await processManager?.stop()
  processManager = null
  await start()
}
