// DeepCode 的目录选择后端：把 `ctx.directoryPicker` 的 native capability
// 交给宿主 Electron 自己的目录对话框，不经 koffi。
//
// 为什么要有这一层（P8-D11，发布阻塞）：
// 官方 native picker 在 Windows 上走
// `spawn(process.execPath, ['worker.cjs'])` 起一个 koffi 驱动的 COM 子进程。
// 打包态 `process.execPath` 是 DeepCode.exe——即便我们已经在 spawn DSH 时
// 注入了 ELECTRON_RUN_AS_NODE=1、worker 也继承得到，那仍然是 Electron 的
// Node realm，koffi 在其中 `readUtf16` 调 `koffi.view()` 会触发
// napi_get_last_error_info 的 FATAL 崩溃。用户看到的是
// "win32 folder dialog worker exited before reporting a result"，
// 于是工作区根本选不了。开发态用真 node，永远复现不了这条。
//
// DeepCode 本来就是 Electron 应用，弹系统目录对话框是它的原生能力。而
// 「怎么向用户要一个路径」本就是宿主的职责，官方只负责拿到路径之后做什么
// ——就像网页上传文件时，文件选择窗口是浏览器弹的而不是网页弹的。
//
// 这一层只在打包态挂载（overlay 由 DeepCode 经 `--patch` 传入）：开发态的
// 官方 picker 是好的，不必替换，也没有基类包可解析。
// @module @see-sol-lab/deepcode-directory-picker

import { DirectoryPicker } from '@deepseek-ai/dsh-host-directory-picker'

/** 宿主回调端点；由 DeepCode 在 spawn DSH 时经环境注入。 */
const ENDPOINT_ENV = 'DEEPCODE_PICKER_ENDPOINT'
/** 单次运行的回调凭证；缺它宿主一律拒绝，本机其它进程无法借这个端点弹窗。 */
const TOKEN_ENV = 'DEEPCODE_PICKER_TOKEN'

/**
 * 请宿主弹一次系统目录对话框。
 *
 * abort 语义：signal 中止的是这次 HTTP 等待，宿主那边已经打开的系统对话框
 * 不会被强行关掉（Electron 没有关闭它的 API）。用户关掉对话框后宿主照常
 * 回应，那次回应没有人接收，仅此而已——**绝不把它当成一次选择结果**。
 * @param {AbortSignal} signal - 调用方/连接的生命周期。
 * @returns {Promise<string | null>} 选中的绝对路径；用户取消时为 null。
 */
async function pickViaHost(signal) {
  const endpoint = process.env[ENDPOINT_ENV]
  const token = process.env[TOKEN_ENV]
  // 缺注入就明确报错，绝不静默退化成"没有 picker"：那会让用户点了没反应，
  // 而这正是 D11 现象本身的样子，分不清是旧 bug 还是新 bug。
  if (endpoint === undefined || endpoint === '' || token === undefined || token === '') {
    throw new Error(`DeepCode 目录选择端点未注入（${ENDPOINT_ENV} / ${TOKEN_ENV} 为空）`)
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-deepcode-picker-token': token },
    signal,
  })
  if (!response.ok) {
    throw new Error(`DeepCode 目录选择失败：宿主返回 ${response.status}`)
  }
  const body = await response.json()
  // 只认字符串路径。宿主取消时给的是 null，任何其它形状都当作"没有选择"，
  // 绝不把 undefined 之类的东西当路径交给官方去 connectWorkspace。
  const picked = typeof body.path === 'string' ? body.path : null
  // 诊断（S12）：这条缝上原本一行日志都没有，于是"工作区没建起来"只能看到
  // 最终结果，看不出是宿主没给路径、还是给了但官方没接。只记形状与末段，
  // 不记完整路径——诊断包会带走这些日志。
  const segments = picked === null ? [] : picked.split('\\').join('/').split('/').filter(part => part !== '')
  const tail = segments[segments.length - 1] ?? ''
  console.error(`[deepcode-picker] host returned ${picked === null ? 'no path (cancelled)' : `a path ending in "${tail}"`}`)
  return picked
}

/**
 * `ctx.directoryPicker` 的 DeepCode 实现（capability 对象在服务生命周期内稳定，
 * 官方消费方会跨调用持有它）。
 */
export default class DeepCodeDirectoryPicker extends DirectoryPicker {
  /** native 交互：宿主屏幕上的一个系统目录选择器。 */
  nativeCapability = {
    kind: 'native',
    pick: signal => pickViaHost(signal),
  }

  /**
   * 本后端的交互能力。
   * @returns {object} 稳定的 native capability 对象。
   */
  capability() {
    return this.nativeCapability
  }
}
