/**
 * node-runtime.ts —— 内置 Node 运行时
 *
 * 【为什么需要这个模块】
 * Electron 应用打包后自带一份 Node.js（和 Chromium 一起塞在可执行文件里），
 * 所以终端用户其实不用单独安装 Node。我们要做的是「借用」这份内置 Node
 * 去运行 DSH 的入口脚本（DSH 本身是个 Node CLI，入口是 lib/bin.js）。
 *
 * 【核心知识点：ELECTRON_RUN_AS_NODE】
 * Electron 的可执行文件（electron.exe）平时是浏览器壳，但当环境变量
 * ELECTRON_RUN_AS_NODE=1 时，它会退化成一个纯 Node 解释器：
 *   electron.exe script.js   ≈   node script.js
 * 于是我们用 process.execPath（当前 electron.exe 的路径）当 node 用，
 * 完全不需要用户机器上装 Node。
 *
 * 【为什么留 system 模式】
 * DSH 可能带原生插件（native addon，如 pty 终端），这类插件对 Node 的
 * ABI 版本敏感。万一 Electron 内置 Node 跑不动，可切回用户自装的 Node。
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

/**
 * 我们启动子进程时 stdio 配的是 ['ignore', 'pipe', 'pipe']：
 *   - stdin（第 0 项）：ignore，不接管键盘输入 → 类型是 null
 *   - stdout（第 1 项）：pipe，可读流 → Readable
 *   - stderr（第 2 项）：pipe，可读流 → Readable
 * 这个类型把三项精确描述出来，比笼统的 ChildProcess 更安全。
 */
export type DshChildProcess = ChildProcessByStdio<null, Readable, Readable>

/** 一份「可用来执行 JS 脚本」的运行时描述 */
export interface RuntimeInfo {
  /** 可执行文件路径。内置模式下就是 electron.exe 自身 */
  execPath: string
  /** 是否走 Electron 内置 Node（true）还是系统 node（false） */
  builtin: boolean
}

export interface SpawnNodeOptions {
  /** 传给入口脚本的参数（不含脚本路径本身） */
  args: string[]
  /** 子进程的工作目录 */
  cwd: string
  /** 追加/覆盖的环境变量 */
  env?: NodeJS.ProcessEnv
}

/**
 * 解析运行时：根据配置决定用内置还是系统 Node。
 */
export function resolveNodeRuntime(mode: 'builtin' | 'system', nodePath?: string): RuntimeInfo {
  if (mode === 'system') {
    // 系统模式：直接用 PATH 里的 node（或用户显式指定的路径）
    return { execPath: nodePath ?? 'node', builtin: false }
  }
  // 内置模式：process.execPath 是当前 Electron 主进程的可执行文件路径
  return { execPath: process.execPath, builtin: true }
}

/**
 * 用指定运行时执行一个 Node 入口脚本（如 DSH 的 lib/bin.js）。
 * 这是「启动边界」的落点：壳只管把进程拉起来，DSH 内部怎么跑与壳无关。
 */
export function spawnNodeScript(
  runtime: RuntimeInfo,
  script: string,
  opts: SpawnNodeOptions,
): DshChildProcess {
  // 继承父进程环境变量，再叠加调用方传入的覆盖项
  const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) }
  // 关键：内置模式下设置这个变量，让 electron.exe 当纯 Node 用
  if (runtime.builtin) env.ELECTRON_RUN_AS_NODE = '1'

  return spawn(runtime.execPath, [script, ...opts.args], {
    cwd: opts.cwd,
    env,
    windowsHide: true, // Windows 下不弹出黑框控制台
    stdio: ['ignore', 'pipe', 'pipe'], // 不接 stdin，stdout/stderr 用管道读
  })
}
