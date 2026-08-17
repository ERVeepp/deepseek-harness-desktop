/**
 * config.ts —— 应用配置
 *
 * v1 阶段配置只从环境变量读取（前缀 DSH_DESKTOP_），
 * 好处是不用做设置界面就能快速验证；后续可以换成 UI 设置页写入同一对象。
 */
export interface AppConfig {
  /** DSH 版本 spec：latest 表示自动解析最新版，也可写死如 0.1.0-rc.6 */
  dshVersion: string
  /** Web UI 监听端口，默认 3080（DSH 官方默认） */
  dshPort: number
  /** Web UI 绑定地址，固定 127.0.0.1（仅本机可访问，更安全） */
  dshHost: string
  /** DSH 进程工作目录（workspace），空则用 userData/workspace */
  workspaceDir: string
  /** Node 运行时：builtin=Electron 内置 Node / system=系统 node */
  nodeMode: 'builtin' | 'system'
  /** 安装 DSH 用的包管理器：pnpm（默认）或 npm */
  pm: 'pnpm' | 'npm'
  /** 手动指定包管理器路径（可选） */
  pmPath?: string
  /** 手动指定 node 路径（nodeMode=system 时） */
  nodePath?: string
  /** 是否在 DSH 异常退出后自动重启 */
  autoRestart: boolean
  /** 自动重启次数上限，超过则放弃并报错 */
  maxRestarts: number
  /** 等待 DSH 打印就绪地址的超时时间（毫秒） */
  readyTimeoutMs: number
  /** 就绪后健康检查的轮询间隔（毫秒） */
  healthIntervalMs: number
}

export function loadConfig(): AppConfig {
  const port = Number(process.env.DSH_DESKTOP_PORT ?? '3080')
  return {
    dshVersion: process.env.DSH_DESKTOP_VERSION ?? 'latest',
    // 端口要做合法性校验：必须是 1~65535 的整数，否则回落到 3080
    dshPort: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3080,
    dshHost: '127.0.0.1',
    workspaceDir: process.env.DSH_DESKTOP_WORKSPACE ?? '',
    nodeMode: process.env.DSH_DESKTOP_NODE_MODE === 'system' ? 'system' : 'builtin',
    pm: process.env.DSH_DESKTOP_PM === 'npm' ? 'npm' : 'pnpm',
    pmPath: process.env.DSH_DESKTOP_PM_PATH || process.env.DSH_DESKTOP_NPM || undefined,
    nodePath: process.env.DSH_DESKTOP_NODE || undefined,
    // 默认开自动重启；设 DSH_DESKTOP_NO_RESTART=1 可关闭
    autoRestart: process.env.DSH_DESKTOP_NO_RESTART !== '1',
    maxRestarts: 5,
    readyTimeoutMs: 120_000, // 首次安装+启动可能较慢，给足 2 分钟
    healthIntervalMs: 3000,
  }
}
