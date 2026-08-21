// DeepCode 皮肤的客户端产物。
//
// **形状是官方 client 运行时的契约，不是随便一种打包格式。** 官方的
// __ModuleLoader__ 负责加载并解析包间依赖，产物必须自注册进它；直接输出
// 原生 ESM 会在浏览器里报 "Cannot use import statement outside a module"，
// 插件加载失败并把整个页面卡在 boot（实机抓获）。
//
// 官方包用 tsdown 打出这个形状。本插件只有一个 apply 与一张常量表，
// 手写产物比为它接一套打包更简单——也让「产物形状是官方契约」这件事
// 直接可见，而不是藏在构建配置里。刻意不保留 TS 源码：一份逻辑两处维护
// 迟早漂移，而这点代码不值得为类型检查付那个代价。
//
// 改动前请对照 packages/client/ui-theme/lib/types/client/index.d.ts：
// overrideTokens 的签名与「每个 token 必须同时给出 light/dark」都在那里。
window.__ModuleLoader__.load({
  id: '@see-sol-lab/deepcode-theme',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** 覆盖层身份：一个来源一层，重复调用替换本层而非叠加。 */
    var OVERRIDE_SOURCE = '@see-sol-lab/deepcode-theme'

    /**
     * 表面 token 覆盖。只动页面底、模块面板、浮层、骨架屏；文字色、边框
     * 语义、间距、圆角一律不碰——那些是官方的可读性契约。
     * 这些值先以注入 CSS 的形式在打包实机上验证过，再原样搬进官方扩展点，
     * 不是纸面设计：纸上分辨不出「透」与「漏」。
     */
    var DEEPCODE_TOKEN_OVERRIDES = {
      // 页面底透明，DeepCode 宿主层的深海/海雾底图才透得上来。整套的地基。
      '--dsw-alias-bg-base': { light: 'transparent', dark: 'transparent' },
      // 模块面板（侧栏、工作区）：浅底要更实，否则云会把文字吃掉。
      '--dsw-alias-bg-module-platform': {
        light: 'rgba(255, 255, 255, 0.42)',
        dark: 'rgba(255, 255, 255, 0.06)',
      },
      '--dsw-alias-bg-multi-select': {
        light: 'rgba(255, 255, 255, 0.55)',
        dark: 'rgba(255, 255, 255, 0.08)',
      },
      // 浮层常叠在面板上，两层半透明会把下面的字透上来糊成一片。
      '--dsw-alias-bg-overlay': {
        light: 'rgba(255, 255, 255, 0.94)',
        dark: 'rgba(28, 30, 34, 0.92)',
      },
      '--dsw-alias-bg-skeleton': {
        light: 'rgba(0, 0, 0, 0.04)',
        dark: 'rgba(255, 255, 255, 0.05)',
      },
    }

    /** 注入官方主题服务；与 package.json 的 dsh.client.inject 对应。 */
    var inject = ['theme']

    /**
     * 装载皮肤：叠一层 token 覆盖，别的什么都不做。
     * 不注册 root、不接管 layout、不写 data-ds-dark-theme、不与官方 React
     * 抢状态。明暗仍由官方 ui-theme preference 决定——Harness 管「现在是明
     * 是暗」，DeepCode 管「明和暗长什么样」。
     * 生命周期交给 ctx.effect：插件卸载时官方自动移除该层，界面回到原样。
     *
     * 顺带承担 DeepCode 的 client settle 标记（P6 下一代健康证据）：
     * 本插件是 --patch 层进入 composition 的唯一 DeepCode client 插件，
     * apply 成功 = 官方 loader 接受了这一轮 composition 里的 DeepCode 层；
     * 失败或 loader 拒绝本行时标记缺失/为 false，宿主据此判 boot 失败。
     * 只报告 { healthy / failed + reason } 级别事实，不送任何会话内容。
     */
    function apply(ctx) {
      try {
        ctx.effect(function () {
          return ctx.theme.overrideTokens(OVERRIDE_SOURCE, DEEPCODE_TOKEN_OVERRIDES)
        })
        window.__deepcodeClientSettled = true
      } catch (error) {
        window.__deepcodeClientSettled = false
        window.__deepcodeClientSettleReason = String((error && error.message) || error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
