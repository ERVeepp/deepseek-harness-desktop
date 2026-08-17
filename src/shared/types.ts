/**
 * types.ts —— 主进程与 preload 共用的类型定义
 *
 * 为什么要单独一个 shared 目录？
 * Electron 有「主进程 / 渲染进程 / 预加载脚本」三种运行环境，
 * 它们的内存互不相通，但可以共享「类型」。把状态结构放这里，
 * 主进程和 preload 都 import 同一个类型，保证两端对数据结构理解一致。
 */

/**
 * 运行状态机：一个很简单的 5 态流转
 *
 *   idle ──▶ installing ──▶ starting ──▶ ready
 *                              │
 *                              └──▶ error（可重试回到 installing）
 */
export type DshStatus =
  | 'idle' // 尚未开始（应用刚启动）
  | 'installing' // 正在解析/安装 DSH 版本
  | 'starting' // 正在启动 DSH 子进程，等待就绪
  | 'ready' // Web UI 已就绪，窗口已跳转
  | 'error' // 出错，详情看 message

/**
 * 渲染进程可见的运行状态快照。
 * 主进程每次状态变化都会把整个对象通过 IPC 推给启动页。
 */
export interface DshState {
  status: DshStatus
  /** 实际安装的 DSH 版本（安装完成后才有） */
  version?: string
  /** Web UI 地址（ready 后才有） */
  url?: string
  /** 错误信息（error 时才有） */
  message?: string
  /** 累计自动重启次数 */
  restarts: number
  /** 最近一条子进程/安装日志，用于在启动页展示进度 */
  lastLog?: string
}
