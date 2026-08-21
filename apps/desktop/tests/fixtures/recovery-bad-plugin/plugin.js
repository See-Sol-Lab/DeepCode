/**
 * S10 fixture plugin: apply 必然抛错，并紧跟着硬退出进程。
 * 与 native-proof-plugin 的 throw 形态同因：web server 行可能在 apply 时
 * 已经监听，裸抛错只留竞态——setImmediate 硬退出保证进程在回答 readiness
 * 探测之前死亡，让"坏插件 → 下一代 boot 失败"路径确定性地落在
 * readiness 阶段（Plugin Mutation Recovery 的触发点）。
 * CommonJS：vendored Loader 的 require 路径同时覆盖 dev（tsx）与打包态。
 */

exports.name = 'deepcode-recovery-bad-plugin'

exports.apply = function apply() {
  setImmediate(() => { process.exit(1) })
  throw new Error('deepcode-recovery-bad-plugin: apply threw on purpose')
}
