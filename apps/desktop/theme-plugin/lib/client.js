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
     * 表面 token 覆盖 + DeepCode 宿主变量。文字**色**与边框语义仍然不碰
     * （官方的可读性契约），但正文字号/行高/承托自 2026-08-23 起是我们的
     * 合法地盘——住户当晚纠偏：「零注入」护的是 harness 技术层，官方 UI
     * 的视觉层允许改（P8 文档 §0.3）。宿主变量走 var(--dsh-*, 官方原值)
     * 回退：原版 dsh web 不受任何影响。
     * 这些值先以注入 CSS 的形式在打包实机上验证过，再原样搬进官方扩展点，
     * 不是纸面设计：纸上分辨不出「透」与「漏」。
     */
    var DEEPCODE_TOKEN_OVERRIDES = {
      // 页面底透明，DeepCode 宿主层的深海/海雾底图才透得上来。整套的地基。
      '--dsw-alias-bg-base': { light: 'transparent', dark: 'transparent' },
      // 模块面板（侧栏、工作区）：浅底要更实，否则云会把文字吃掉。
      //
      // 深色 0.06 → 0.10（P8-D2，2026-08-22）：住户报侧边栏「死黑」。根因不是这个
      // 值本身写错，而是侧栏正好压在深海底图最暗的左边缘上——6% 的白提不动那块
      // 底，于是整条侧栏看起来是纯黑，而不是「透出深海」。
      //
      // **这是一个试值**，按住户定的「透明度要压住」取的下限：底图必须仍然透得
      // 上来，不能被稀释成一块灰板。视觉的事纸上分不出来，实机看过再调——往上
      // 调更亮但底图更淡，往下调会重新变黑。
      '--dsw-alias-bg-module-platform': {
        light: 'rgba(255, 255, 255, 0.42)',
        dark: 'rgba(255, 255, 255, 0.10)',
      },
      // 跟着 platform 等比例提，保住「选中态比底色亮一档」这个层次关系。
      '--dsw-alias-bg-multi-select': {
        light: 'rgba(255, 255, 255, 0.55)',
        dark: 'rgba(255, 255, 255, 0.13)',
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
      // 设置弹窗等二级表面（P8-D41，住户定）：官方 layer-2 是纯白/死黑，
      // 与玻璃化侧栏格格不入。弹窗背后自带 mask+backdrop 模糊，半透后即
      // 天然毛玻璃。比侧栏保守（0.86）：面板承载大量设置文字，可读优先。
      // **试值**。注意 layer-2 是共享 token，其他二级表面会一起玻璃化——
      // 方向一致（全 GUI 统一质感），实机看过再调。
      '--dsw-alias-bg-layer-2': {
        light: 'rgba(252, 252, 252, 0.86)',
        dark: 'rgba(24, 27, 33, 0.86)',
      },
      // 侧栏（P8-D2，2026-08-23 真身落网）：侧栏的背景从来不是
      // module-platform，是它自己的 --dsw-specific-sidebar-fill——官方给的是
      // 实心色（浅 neutral-bluish-50 / 深 neutral-bluish-900）。之前反复调
      // module-platform 当然一动不动：调的不是它。半透深色让底图透上来，
      // 这才是「玻璃感」的正确开关。
      //
      // 深色 0.42 住户 2026-08-23 验收：「玻璃感出来了！非常完美，就是这个
      // 效果」——深色定稿。浅色首发 0.60 被指太实：「浅色的透明感要和深色
      // 一样才行」，0.60 → 0.38 对齐深色的透明程度（试值，浅色下海雾底图
      // 亮，同等透明度不会像深色那样发黑）。
      '--dsw-specific-sidebar-fill': {
        light: 'rgba(249, 248, 248, 0.38)',
        dark: 'rgba(16, 20, 26, 0.42)',
      },
      // ── 以下是 DeepCode 自己的宿主变量（P8-D25），不是官方 token。──
      // 官方 AssistantMarkdown.module.css 把 figma 的 16/28 与「无气泡」写成
      // var(--dsh-assistant-*, 原值) 的回退形式：原版 dsh web 里这些变量不存在,
      // 样式与官方完全一致；只有这里供值时才生效。overrideTokens 落在 <body>
      // 的 inline CSS 变量上，任何变量名都合法（契约是 Record<string, modes>）。
      //
      // 住户 2026-08-22 凌晨报：深色下 DS 回答「看花眼」、字号比同屏
      // Claude Code 明显大。首发 14px 验收（2026-08-23）仍嫌大，指定对齐
      // Claude Code 的正文（13px）：两侧正文一起降——assistant 13/22，用户
      // 气泡 13/20（官方 16/24 同比例收）。
      //
      // assistant 承托背景**不做**（住户 2026-08-23 定）：CC 与 codex 都只给
      // 用户消息带气泡，assistant 全宽裸排是行业惯例，「看花眼」由 D24 遮罩
      // 加深 + 字号缩小解决。官方 CSS 里的 --dsh-assistant-bubble-* 钩子保留
      // （回退即官方原样，不供值就是不存在），将来要试承托改这里就行。
      '--dsh-assistant-font-size': { light: '13px', dark: '13px' },
      // 22 → 19 → 21：首版 19 住户实测「正文稍微有点挤」，按她指定加回 2px。
      // 21/13 ＝ 1.62 倍，比 Claude Code 略松一档，中文长段落更耐读。
      '--dsh-assistant-line-height': { light: '21px', dark: '21px' },
      // 收官包验收（2026-08-23）：上面两个钩子被 .markdown 根上的
      // `font: var(--dsw-font-markdown-base)`（简写，自带 16px/28px）盖掉，
      // 于是「用户气泡变小了、DS 正文没变」。这层字号本身就是官方 token，
      // 直接覆盖——markdown 正文 13/22 对齐 Claude Code；标题/代码块各有
      // 自己的 token，不动。
      '--dsw-font-markdown-base': {
        light: '13px/21px var(--dsw-font-family)',
        dark: '13px/21px var(--dsw-font-family)',
      },
      // 用户气泡（P8-D25 返工补漏）：第一批只改了 assistant 侧，住户实测
      // 指出自己发出的正文一样大——官方 .bubble 的 16/24 同样包了 var 回退。
      '--dsh-user-bubble-font-size': { light: '13px', dark: '13px' },
      '--dsh-user-bubble-line-height': { light: '20px', dark: '20px' },
      // 统计状态栏底色（P8-D33）：长回复滚动时正文从这行字底下穿过，两层
      // 文字叠在一起。住户定：浅色加白、深色加灰，与对话区卡片一致。
      // 高不透明度而非纯实色：保留一丝底图气息又足以隔开文字。**试值**。
      '--dsh-statsline-bg': {
        light: 'rgba(255, 255, 255, 0.94)',
        dark: 'rgba(36, 39, 45, 0.94)',
      },
      // D33 三定案（住户 2026-08-23 10:27，推翻「对齐输入框卡片满宽」）：
      // 居中圆角胶囊，只包统计文字那一段。fit-content + margin:auto（上游
      // 已有）+ 全角圆角 + 贴字内 padding；此前的 max-width/side-pad 拉宽
      // 供值随之撤除（钩子保留在上游，回退即官方几何）。底色沿用 0.94。
      '--dsh-statsline-width': { light: 'fit-content', dark: 'fit-content' },
      '--dsh-statsline-radius': { light: '999px', dark: '999px' },
      '--dsh-statsline-padding': { light: '3px 14px', dark: '3px 14px' },
      // ── P8-D45 比例连锁（住户 2026-08-23，正文 13px 后周边等比收）。
      // 锚点「原值 ×0.7~0.8」，全部试值实机调：
      // ① 段落间距 16 → 11；② 思维链/工具行 14/24 → 11/18；
      // ③ 底部元信息：时间标签 14/24 → 11/18，图标钮 28/6/16 → 22/4/13，
      //    统计行 12/20 → 10/16。
      '--dsh-assistant-block-gap': { light: '8px', dark: '8px' },
      '--dsh-assistant-actions-gap': { light: '8px', dark: '8px' },
      // ── 行距收紧（住户 2026-08-24：「字号缩过之后行间距显得过大，全部收到
      //    原来的 70%」）。D45 收了字号与行高，但**装文字的盒子没跟着收**，
      //    于是每行的字变小、行与行之间的空当原样留着，整体就发散。
      //
      //    这一批按 70% 收的是「空当」，三处：
      //    ① 转录块间距 --dsh-chat-block-gap 16 → 11（think/工具行、正文段
      //       之间的空隙，住户截图里最扎眼的那一处）；
      //    ② think/工具行的盒子高度 --dsh-chrome-row-height 24 → 18
      //       （盒子原本比里面的 11/18 文字高出 6px，纯属空余）；
      //    ③ assistant 正文块间距与页脚偏移 11 → 8。
      //
      //    **行高（line-height）没有按 70% 收**，这是我的判断，不是漏做：
      //    行高管的是一行**内部**的高度，13px 正文配 70% 行高＝15px，中文的
      //    上下笔画会互相贴住，读起来比现在更累。这一批取 22 → 19（1.46 倍，
      //    与 Claude Code 正文一档），chrome 行 18 → 16 同理。住户看过实机
      //    若仍嫌松，行高还能再收一档，但 15px 是不该越过的线。
      '--dsh-chat-block-gap': { light: '11px', dark: '11px' },
      '--dsh-chrome-row-height': { light: '18px', dark: '18px' },
      // ── markdown 正文内部的块节奏（住户 2026-08-24 二轮实机：思维链与
      //    工具行的间距「现在很好」，但**标题周围**没动过——她一眼看出来了）。
      //    上一批只改了标题的**行高**，而标题上下的空当在 MarkdownText 里
      //    另有一套硬编码：h1-h3 上 32px、p / 列表 16px、列表项 6px，全是
      //    照 16px 正文画的 figma 值，字号缩到 13px 后原样留着。同样按 70%：
      //    标题上边距 32 → 22、块边距 16 → 11、列表项 6 → 4。
      '--dsh-markdown-heading-top': { light: '22px', dark: '22px' },
      '--dsh-markdown-block-margin': { light: '11px', dark: '11px' },
      '--dsh-markdown-list-gap': { light: '4px', dark: '4px' },
      // 列表符号的行高必须跟正文走，否则圆点会掉出自己那行的基线。
      '--dsh-markdown-marker-line-height': { light: '21px', dark: '21px' },
      // ④ D29 验收返工（住户 2026-08-23，「忽大忽小」）：标题/表格是官方
      //    token（font 简写），没跟正文缩。锚点同 ×0.75 左右：
      //    h1 24/34→18/26、h2 22/32→16/24、h3 20/30→15/23、h4 16/28→14/22、
      //    表格 15/25→12/20（表头同值、保 500 字重）。
      // 行高一律 −3（住户 2026-08-24 行距收紧）：字号不动，只把行内空当收掉。
      '--dsw-font-markdown-h1': { light: '700 18px/23px var(--dsw-font-family)', dark: '700 18px/23px var(--dsw-font-family)' },
      '--dsw-font-markdown-h2': { light: '700 16px/21px var(--dsw-font-family)', dark: '700 16px/21px var(--dsw-font-family)' },
      '--dsw-font-markdown-h3': { light: '700 15px/20px var(--dsw-font-family)', dark: '700 15px/20px var(--dsw-font-family)' },
      '--dsw-font-markdown-h4': { light: '600 14px/19px var(--dsw-font-family)', dark: '600 14px/19px var(--dsw-font-family)' },
      '--dsw-font-markdown-table': { light: '12px/17px var(--dsw-font-family)', dark: '12px/17px var(--dsw-font-family)' },
      '--dsw-font-markdown-table-head': { light: '500 12px/17px var(--dsw-font-family)', dark: '500 12px/17px var(--dsw-font-family)' },
      '--dsh-chrome-row-font-size': { light: '11px', dark: '11px' },
      '--dsh-chrome-row-line-height': { light: '16px', dark: '16px' },
      '--dsh-meta-font-size': { light: '11px', dark: '11px' },
      '--dsh-meta-line-height': { light: '16px', dark: '16px' },
      '--dsh-iconaction-size': { light: '22px', dark: '22px' },
      '--dsh-iconaction-pad': { light: '4px', dark: '4px' },
      '--dsh-iconaction-glyph': { light: '13px', dark: '13px' },
      '--dsh-statsline-font-size': { light: '10px', dark: '10px' },
      '--dsh-statsline-line-height': { light: '14px', dark: '14px' },
      // 审批卡片配色（住户 2026-08-23 深夜定）：官方 warn 黄与整体蓝色视觉
      // 不和谐，改品牌蓝系。只经 ApprovalPanel 的 --dsh-approval-* 钩子生效，
      // 其余 warn 黄（状态点/轨迹/ANSI）不受影响。
      '--dsh-approval-accent': { light: '#4d6bfe', dark: '#6799fe' },
      '--dsh-approval-accent-soft': { light: 'rgba(77, 107, 254, 0.08)', dark: 'rgba(103, 153, 254, 0.12)' },
      '--dsh-approval-border': { light: 'rgba(77, 107, 254, 0.28)', dark: 'rgba(103, 153, 254, 0.35)' },
      // P8-D46（住户定）：浅色用户气泡从官方浅紫（deepseek-50）改纯白，
      // 视觉更干净；深色保持官方原值（neutral-bluish-850）不动。
      '--dsw-specific-bubble': {
        light: 'rgb(255, 255, 255)',
        dark: 'rgb(44, 44, 46)',
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
