import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DshState } from '../shared/types'

/**
 * preload/index.ts —— 预加载脚本（主进程与渲染进程之间的安全桥）
 *
 * 【Electron 安全模型】
 * 默认情况下渲染进程（网页）不能直接访问 Node/Electron 能力，否则网页
 * 一旦被攻破就能执行任意代码。所以窗口配置了：
 *   - contextIsolation: true（渲染进程 JS 与 preload 的 JS 世界隔离）
 *   - nodeIntegration: false（渲染进程拿不到 Node）
 * 那渲染进程怎么跟主进程通信？靠 preload 通过 contextBridge 暴露的
 * 一个白名单 API。只有这里声明的几个方法能被页面调用，其余一律封死。
 *
 * 【两种 IPC 模式】
 *   - invoke/handle：请求-响应式，渲染进程调用后能拿到返回值（getState）
 *   - send/on：单向消息，发完不等待（restart、quit）
 *   - 主进程主动推送到渲染进程：main 里 webContents.send，这里 ipcRenderer.on 收
 */

/** 暴露给页面的 API 对象 */
const api = {
  /** 拉取当前状态快照（页面初次加载时用） */
  getState: (): Promise<DshState> => ipcRenderer.invoke('dsh:get-state'),
  /** 订阅状态变化，返回一个取消订阅函数 */
  onState: (callback: (state: DshState) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, s: DshState): void => callback(s)
    ipcRenderer.on('dsh:state', listener)
    return () => {
      ipcRenderer.removeListener('dsh:state', listener)
    }
  },
  /** 让主进程重启 DSH */
  restart: (): void => {
    ipcRenderer.send('dsh:restart')
  },
  /** 退出应用 */
  quit: (): void => {
    ipcRenderer.send('dsh:quit')
  },
}

// 把 API 挂到 window.dshDesktop 上，页面通过它访问
contextBridge.exposeInMainWorld('dshDesktop', api)
