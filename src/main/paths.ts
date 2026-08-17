/**
 * paths.ts —— 应用数据目录布局
 *
 * Electron 的 app.getPath('userData') 会返回一个专属于本应用的目录
 * （Windows 下是 %APPDATA%/deepseek-harness-desktop）。
 * 我们把所有「运行时产生的数据」都塞进去，好处：
 *   1. 不污染用户 HOME 目录；
 *   2. 卸载/清理时删掉这一个目录即可。
 */
import { app } from 'electron'
import path from 'node:path'

/** 应用内各目录的绝对路径集合 */
export interface AppPaths {
  /** 应用数据根目录（userData） */
  userData: string
  /** 各版本 DSH 的安装根目录：versions/<版本号>/ */
  versionsRoot: string
  /** DSH 自身的 home（对应环境变量 $DSH_HOME），存 profile 和配置 */
  dshHome: string
  /** 默认工作区目录，作为 DSH 进程的启动目录（cwd） */
  defaultWorkspace: string
  /** 预留的日志目录 */
  logsDir: string
}

export function getPaths(): AppPaths {
  const userData = app.getPath('userData')
  return {
    userData,
    versionsRoot: path.join(userData, 'versions'),
    dshHome: path.join(userData, 'dsh-home'),
    defaultWorkspace: path.join(userData, 'workspace'),
    logsDir: path.join(userData, 'logs'),
  }
}
