/**
 * loading.js —— 启动页脚本（渲染进程）
 *
 * 这个页面是「壳自己的 UI」，只负责两件事：
 *   1. 展示 DSH 的安装/启动进度（状态来自主进程 IPC 推送）
 *   2. 出错时提供「重试 / 退出」按钮
 *
 * 它通过 window.dshDesktop（preload 暴露的 API）与主进程通信。
 * 一旦 DSH 就绪，主进程会把整个窗口跳转到 DSH 的 Web UI，
 * 这个启动页的使命就结束了。
 */

// 页面元素
const statusEl = document.getElementById('status') // 主状态文本
const detailEl = document.getElementById('detail') // 详细日志区
const actionsEl = document.getElementById('actions') // 重试/退出按钮容器
const retryBtn = document.getElementById('retry')
const quitBtn = document.getElementById('quit')

// 状态 → 中文提示的映射
const STATUS_TEXT = {
  idle: '正在初始化…',
  installing: '正在安装 DeepSeek Harness…',
  starting: '正在启动本地服务…',
  ready: '服务已就绪，正在打开…',
  error: '启动失败',
}

/**
 * 根据主进程推来的状态快照渲染页面。
 * state 结构与 src/shared/types.ts 里的 DshState 一致。
 */
function render(state) {
  statusEl.textContent = STATUS_TEXT[state.status] ?? state.status
  const parts = []
  if (state.version) parts.push('版本 ' + state.version)
  if (state.url) parts.push(state.url)
  if (state.restarts > 0) parts.push('已自动重启 ' + state.restarts + ' 次')
  if (state.lastLog) parts.push(state.lastLog)
  if (state.status === 'error' && state.message) parts.push(state.message)
  detailEl.textContent = parts.filter(Boolean).join('\n')
  // 只有出错时才显示重试/退出按钮
  actionsEl.hidden = state.status !== 'error'
}

retryBtn.addEventListener('click', () => window.dshDesktop.restart())
quitBtn.addEventListener('click', () => window.dshDesktop.quit())

// 订阅后续状态推送；并拉一次当前状态（页面可能晚于状态变化才加载）
window.dshDesktop.onState(render)
window.dshDesktop.getState().then(render)
