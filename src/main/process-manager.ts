import http from 'node:http'
import path from 'node:path'
import { spawnNodeScript, type RuntimeInfo, type DshChildProcess } from './node-runtime'
import type { DshStatus } from '../shared/types'

export interface ProcessManagerOptions {
  /** DSH 入口脚本绝对路径（来自版本管理） */
  binPath: string
  /** Node 运行时（内置或系统） */
  runtime: RuntimeInfo
  /** DSH 自身 home（$DSH_HOME） */
  dshHome: string
  /** Web UI 绑定地址 */
  host: string
  /** Web UI 端口 */
  port: number
  /** DSH 进程工作目录（workspace） */
  workspaceDir: string
  /** 等待就绪超时（毫秒） */
  readyTimeoutMs: number
  /** 健康检查间隔（毫秒） */
  healthIntervalMs: number
  /** 自动重启次数上限 */
  maxRestarts: number
  /** 是否自动重启 */
  autoRestart: boolean
  onLog: (line: string) => void
  onStatus: (status: DshStatus, message?: string) => void
  onReady: (url: string) => void
}

/**
 * process-manager.ts —— DSH 进程托管
 *
 * 这是整个壳最核心、也是「适配压力」集中的地方。它负责：
 *   1. spawn：拉起 DSH 子进程（DSH 是个长驻的 Web 服务）
 *   2. 就绪探测：DSH 启动有耗时，我们要等它打印出访问地址才算就绪
 *   3. 健康检查：就绪后周期探活，确认服务没挂
 *   4. 异常重启：进程意外退出时自动拉起（带退避，防止反复重启风暴）
 *   5. 优雅退出：应用关闭时回收子进程，避免残留孤儿进程
 *
 * 【就绪探测原理】
 * DSH 启动成功后会往 stdout 打印一行 `dsh web: http://127.0.0.1:<port>`。
 * 我们不断收集子进程输出，用正则匹配这行，匹配到即认为就绪——
 * 这比「盲等几秒再访问」可靠得多。
 *
 * 【健康检查原理】
 * 就绪后每隔几秒向 http://127.0.0.1:<port> 发一个 GET，能收到任何
 * 响应（哪怕 404）都说明端口还在监听。真正的崩溃由子进程 exit 事件
 * 兜底，健康检查只负责早点发现「端口死了但进程还活着」的异常。
 */
export class ProcessManager {
  /** 当前 DSH 子进程 */
  private child: DshChildProcess | undefined
  /** 是否在主动停止（用于区分「自己关」和「异常退出」） */
  private stopping = false
  /** 已累计的重启次数 */
  private restarts = 0
  /** 健康检查定时器 */
  private healthTimer: NodeJS.Timeout | undefined
  /** 就绪超时定时器 */
  private readyTimer: NodeJS.Timeout | undefined
  /** 是否已就绪/已定局（防止重复触发 resolve/reject） */
  private settled = false

  constructor(private readonly opts: ProcessManagerOptions) {}

  /** 启动 DSH 并等待就绪，返回 Web UI 地址 */
  async start(): Promise<string> {
    this.stopping = false
    this.settled = false
    this.restarts = 0
    return this.boot()
  }

  /** 单次启动（内部可被自动重启反复调用） */
  private boot(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const { binPath, runtime, dshHome, host, port, workspaceDir, readyTimeoutMs } = this.opts
      this.opts.onStatus('starting')

      // 用内置/系统 Node 执行 DSH 入口脚本：等价于命令行 `dsh web --host ... --port ...`
      const child = spawnNodeScript(runtime, binPath, {
        args: ['web', '--host', host, '--port', String(port)],
        cwd: workspaceDir,
        env: {
          DSH_HOME: dshHome, // DSH 的 profile/配置都落到应用数据目录
          DSH_AGENTS_HOME: path.join(dshHome, '.agents'),
          // 让 DSH 的目录选择器走「浏览器内浏览」而非原生 OS 对话框。
          // 官方 -auto chooser 见到 SSH_* 环境变量会判定为 browse；
          // 否则 Windows 上会尝试弹原生文件夹对话框（spawn 子进程开
          // IFileOpenDialog），在 Electron 内置 Node 这种子进程里会报
          // "win32 folder dialog worker exited before reporting a result"。
          SSH_CONNECTION: 'deepseek-harness-desktop',
        },
      })
      this.child = child

      // 收集子进程所有输出，用于就绪探测和日志回显
      let output = ''
      const onData = (d: Buffer): void => {
        const s = d.toString()
        output += s
        // 按行回显给上层（启动页 / 终端）
        for (const line of s.split(/\r?\n/)) {
          if (line.trim()) this.opts.onLog(line)
        }
        // 匹配就绪信号 `dsh web: http://...`
        const match = /dsh web:\s*(https?:\/\/[^\s]+)/.exec(output)
        if (match && !this.settled) {
          this.settled = true
          clearTimeout(this.readyTimer)
          const url = match[1].replace('0.0.0.0', host)
          this.startHealthCheck(url)
          this.opts.onReady(url)
          resolve(url)
        }
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)

      // 超过就绪超时还没打印地址 → 判定启动失败
      this.readyTimer = setTimeout(() => {
        if (!this.settled) {
          this.settled = true
          reject(new Error(`DSH 在 ${readyTimeoutMs / 1000}s 内未就绪。输出：\n${output.slice(-1000)}`))
        }
      }, readyTimeoutMs)

      // spawn 本身失败（如找不到可执行文件）
      child.on('error', (err) => {
        if (!this.settled) {
          this.settled = true
          reject(new Error(`无法启动 DSH 进程：${err.message}`))
        }
      })

      // 子进程退出：清理定时器；若是异常退出且非主动关闭 → 自动重启
      child.on('exit', (code, signal) => {
        clearTimeout(this.readyTimer)
        this.stopHealthCheck()
        this.child = undefined
        if (this.settled && !this.stopping) {
          this.handleUnexpectedExit(code, signal)
        }
      })
    })
  }

  /** 处理已就绪之后的意外退出：按退避策略自动重启 */
  private handleUnexpectedExit(code: number | null, signal: string | null): void {
    if (!this.opts.autoRestart) {
      this.opts.onStatus('error', `DSH 进程已退出（code=${code ?? signal}），自动重启已禁用`)
      return
    }
    this.restarts += 1
    // 超过上限就不再重试，避免无限重启循环
    if (this.restarts > this.opts.maxRestarts) {
      this.opts.onStatus('error', `DSH 进程连续异常退出 ${this.restarts} 次，已停止自动重启`)
      return
    }
    // 指数退避：1s、2s、4s……封顶 30s
    const delay = Math.min(1000 * 2 ** (this.restarts - 1), 30_000)
    this.opts.onStatus('starting', `DSH 进程异常退出（code=${code ?? signal}），${delay / 1000}s 后第 ${this.restarts} 次重启`)
    setTimeout(() => {
      if (this.stopping) return
      this.settled = false
      void this.boot().catch((err: Error) => {
        this.opts.onStatus('error', err.message)
      })
    }, delay)
  }

  /** 就绪后周期探活 */
  private startHealthCheck(url: string): void {
    this.stopHealthCheck()
    this.healthTimer = setInterval(() => {
      const req = http.get(url, { timeout: 2000 }, (res) => {
        res.resume() // 不关心响应体，能收到响应就说明活着
      })
      req.on('timeout', () => req.destroy())
      req.on('error', () => {
        // 不立即判定崩溃（交给 exit 事件处理），这里只提示端口无响应
        if (this.child && this.child.exitCode === null) {
          this.opts.onLog(`[健康检查] ${url} 无响应`)
        }
      })
    }, this.opts.healthIntervalMs)
  }

  private stopHealthCheck(): void {
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = undefined
  }

  /**
   * 主动停止 DSH 进程。
   * 先发 SIGTERM 让 DSH 优雅落盘（最多等 6 秒），超时再 SIGKILL 强杀。
   * 注：Windows 没有 POSIX 信号语义，SIGTERM 实际就是强杀。
   */
  async stop(): Promise<void> {
    this.stopping = true
    clearTimeout(this.readyTimer)
    this.stopHealthCheck()
    const child = this.child
    if (child === undefined || child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const forceTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 已退出 */
        }
        resolve()
      }, 6000)
      child.once('exit', () => {
        clearTimeout(forceTimer)
        resolve()
      })
      try {
        child.kill('SIGTERM')
      } catch {
        /* 已退出 */
      }
    })
    this.child = undefined
  }
}
