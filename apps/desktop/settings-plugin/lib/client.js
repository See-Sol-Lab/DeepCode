// DeepSeekGUI 设置分区的客户端产物（P8-D39）。
//
// **形状是官方 client 运行时的契约**（与 theme-plugin 同则）：产物必须经
// window.__ModuleLoader__ 自注册，factory 收到 loader 的 require，从中取
// react 与官方服务。手写产物，不接打包器；改动前对照
// packages/client/ui-settings 的 slot 契约（settings.section）。
//
// 职责：在官方设置页注册两个 DeepSeekGUI 分区——「Harness（桌面）」与
// 「插件管理（本地）」。分区内一切动作经本机回环控制桥（main 的
// /control/model、/control/command）回到与 Chrome 菜单同一个命令出口，
// 没有第二事实源。页面 URL 没有控制桥参数（外部浏览器打开 3080）时，
// 插件什么都不注册——那里没有桌面可控。
//
// 文案字典集中在 STRINGS（zh/en 同键；D29 双语化时英文由 DS 重审）。
window.__ModuleLoader__.load({
  id: '@see-sol-lab/deepseekgui-settings',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement

    /** 本插件的 locale namespace（官方 locale 服务按 NS 分发字典）。 */
    var NS = 'deepseekgui.desktop'

    var STRINGS = {
      zh: {
        'nav.harness': 'Harness（桌面）',
        'nav.plugins': '插件管理（本地）',
        'browser.toggle': '浏览器面板',
        'bridge.error': '无法连接 DeepSeekGUI 桌面控制通道：',
        'bridge.loading': '正在读取桌面状态…',
        'busy': '执行中…',
        'harness.status': '运行状态',
        'harness.pending': '待确认',
        'harness.location': '位置',
        'harness.home.managed': '托管模式',
        'harness.home.existing': '已有目录',
        'harness.permission': '权限模式',
        'permission.sandbox': '沙盒模式（推荐）',
        'permission.full-access': '完全访问（高风险）',
        'permission.unavailable': '（权限服务不可用）',
        'permission.not-recommended': '当前不是推荐预设：沙盒模式之外，智能体可以直接改动更多东西。',
        'term.ps7.note': '未检测到 PowerShell 7：DSH 终端会退回 Windows PowerShell 5。装上 PowerShell 7 体验更好——它只影响你自己的终端，不影响智能体的沙盒。',
        'status.idle': '未运行',
        'status.starting': '正在启动',
        'status.switching': '正在切换',
        'status.recovering': '正在恢复',
        'status.stopping': '正在停止',
        'status.running': '运行中',
        'status.recovered': '已恢复',
        'status.failed': '启动失败',
        'sessions.warn': '你的对话数量已经超过 5 万个，程序内存可能会被撑爆，建议清理一些不再需要的对话。',
        'profiles.title': 'Profiles',
        'profiles.none': '（该 Home 下没有 profile）',
        'profiles.not-discovered': '（尚未发现，点击「刷新 Profiles」）',
        'profiles.discovery-failed': '发现失败：',
        'profile.active': '当前',
        'profile.switch': '切换',
        'profile.headless': '无桌面界面',
        'profile.malformed': '配置有问题',
        'profile.boot-failing': '上次启动失败',
        'action.refresh': '刷新 Profiles',
        'action.restart': '重启 Harness',
        'action.choose-existing': '选择已有 Harness Home…',
        'action.use-managed': '使用托管 Harness Home',
        'candidate.title': '选择该 Home 下的 profile',
        'candidate.none': '该目录下没有可启动的 profile',
        'candidate.cancel': '取消',
        'recovery.title': '上次启动失败详情',
        'recovery.stage': '失败阶段',
        'recovery.message': '失败消息',
        'recovery.recovered-to': '恢复目标',
        'plugins.action': '操作',
        'plugins.action.add': '安装插件',
        'plugins.action.remove': '移除插件',
        'plugins.action.update': '更新插件',
        'plugins.action.install': '安装 / 修复依赖',
        'plugins.spec.hint': '在下面输入插件包名，点「执行」即可安装：',
        'plugins.spec.market': '建议优先安装插件市场 dsh-plugin，装好后就能在图形界面里浏览全部插件，不必再手打包名。',
        'plugins.spec.limits': '也可以填本地插件文件夹的完整路径。不支持 ^1.0.0 这类范围写法；本地路径不能带空格。',
        'plugins.spec.placeholder': '插件包名，如 dsh-plugin',
        'plugins.run': '执行',
        'plugins.cancel': '取消',
        'plugins.verify-note': '写入前会弹出目标确认；发现、浏览与刷新不写入任何内容。',
        'plugins.step.running': '运行中',
        'plugins.step.post-check': '验证结果中',
        'plugins.step.done': '完成',
        'plugins.step.failed': '失败',
        'plugins.step.cancelled': '已取消',
        'plugins.output': '输出',
        'plugins.handoff': '插件变更已完成，需要重启 Harness 才会进入新的 Loader composition。',
        'plugins.restart-now': '立即重启',
        'plugins.later': '稍后',
        'plugins.installed': '已安装依赖',
        'plugins.loaded': '已进入 Loader',
        'plugins.empty': '（空）',
        'plugins.inventory-none': '（尚未发现任何 profile，请先在 Harness 分区刷新）',
        'plugins.recovery.pending': '上一次插件变更正在等待重启验证。',
        'plugins.recovery.needed': '插件变更导致 Harness 启动失败。',
        'plugins.recovery.drift': '插件变更后 Profile 文件被外部修改；自动恢复已停止。',
        'plugins.recovery.recovered': '上一次插件变更导致启动失败，已自动恢复之前的配置。',
        'plugins.recovery.restore': '恢复之前的插件配置',
        'plugins.recovery.abandon': '放弃恢复（保留当前状态）',
        'plugins.recovery.open-profile': '打开 Profile 文件夹',
        'nav.feedback': 'BUG 诊断与反馈',
        'fb.prompt': '遇到了什么问题？',
        'fb.placeholder': '描述你遇到的问题（保存没反应、启动失败、界面卡住……）。先说出来，发送之后 AI 会帮你排查和整理。',
        'fb.send': '发送给 AI 排查',
        'fb.sending': 'AI 正在排查…（最多约 30 秒；结果会回到这里，不用重复点）',
        'fb.degraded': 'AI 排查当前不可用（Harness 未运行或正在恢复中）。已改用静态 issue 模板预填——发送功能不受影响。',
        'fb.diagnostics': '诊断包（已自动脱敏，可编辑）',
        'fb.diagnostics.note': '诊断包在生成时已自动脱敏（用户名、路径、密钥）。发送给 AI 和提交前可以在这里查看和编辑。',
        'fb.reply': 'AI 排查回复',
        'fb.issue-title': 'issue 预览',
        'fb.copy-open': '复制并打开 GitHub',
        'fb.gateway.submit': '没有 GitHub？直接提交给我们',
        'fb.gateway.export': '没有 GitHub？导出反馈文件',
        'diag.build-info': '构建信息',
        // 构建信息的行标签（住户 2026-08-24：这一区原本是英文硬编码，D29
        // 双语化漏了它，界面上一堆英文夹着两行中文）。导出文本仍走英文
        // 标签，不受这份字典影响——贴进 issue 的东西谁都读得懂更要紧。
        'diag.build.app': '版本',
        'diag.build.dsh': '内嵌 Harness',
        'diag.build.runtime': '运行环境',
        'diag.build.home': 'Harness 目录',
        'diag.build.profile': '当前 Profile',
        'diag.build.status': '运行状态',
        'diag.build.log': '日志文件',
        'diag.build.updated': '上次更新',
        'diag.last-exit.clean': '上次退出：正常',
        'diag.last-exit.unclean': '上次退出：未正常退出（本次启动已收集证据）',
        'diag.last-exit.unknown': '上次退出：无历史证据',
        'diag.open-log': '打开日志文件夹',
        'diag.export': '导出诊断包',
        'diag.last-export': '最近导出：',
        'diag.copy-path': '复制完整路径',
        // D29 授权改动：line() 的「标签：值」分隔符从硬编码全角冒号改为字典取值，
        // zh 保持全角，en 用半角加空格（官方 en 风格）。
        'format.colon': '：',
      },
      en: {
        'nav.harness': 'Harness (Desktop)',
        'nav.plugins': 'Plugins (Local)',
        'browser.toggle': 'Browser Panel',
        'bridge.error': 'Could not reach the DeepSeekGUI desktop control channel: ',
        'bridge.loading': 'Loading desktop state…',
        'busy': 'Working…',
        'harness.status': 'Status',
        'harness.pending': 'Pending',
        'harness.location': 'Location',
        'harness.home.managed': 'Managed',
        'harness.home.existing': 'Existing directory',
        'harness.permission': 'Permission mode',
        'permission.sandbox': 'Sandbox (recommended)',
        'permission.full-access': 'Full Access (high risk)',
        'permission.unavailable': '(permission service unavailable)',
        'permission.not-recommended': 'Not the recommended preset: outside Sandbox mode the agent can change more on its own.',
        'term.ps7.note': 'PowerShell 7 not found: the DSH Terminal falls back to Windows PowerShell 5. Installing PowerShell 7 gives a better terminal \u2014 it only affects your own terminal, never the agent sandbox.',
        'status.idle': 'Not running',
        'status.starting': 'Starting',
        'status.switching': 'Switching',
        'status.recovering': 'Recovering',
        'status.stopping': 'Stopping',
        'status.running': 'Running',
        'status.recovered': 'Recovered',
        'status.failed': 'Boot failed',
        'sessions.warn': 'You have more than 50,000 conversations. This can grow large enough to exhaust the app memory. Consider clearing out ones you no longer need.',
        'profiles.title': 'Profiles',
        'profiles.none': '(no profiles under this home)',
        'profiles.not-discovered': '(not discovered yet — click "Refresh Profiles")',
        'profiles.discovery-failed': 'Discovery failed: ',
        'profile.active': 'active',
        'profile.switch': 'Switch',
        'profile.headless': 'headless',
        'profile.malformed': 'malformed',
        'profile.boot-failing': 'last boot failed',
        'action.refresh': 'Refresh Profiles',
        'action.restart': 'Restart Harness',
        'action.choose-existing': 'Choose existing Harness Home…',
        'action.use-managed': 'Use managed Harness Home',
        'candidate.title': 'Choose a profile in this home',
        'candidate.none': 'No bootable profile in this directory',
        'candidate.cancel': 'Cancel',
        'recovery.title': 'Last boot failure',
        'recovery.stage': 'Stage',
        'recovery.message': 'Message',
        'recovery.recovered-to': 'Recovered to',
        'plugins.action': 'Action',
        'plugins.action.add': 'Add plugin',
        'plugins.action.remove': 'Remove plugin',
        'plugins.action.update': 'Update plugin',
        'plugins.action.install': 'Install / repair dependencies',
        'plugins.spec.hint': 'Enter the plugin package name below, then click Run:',
        'plugins.spec.market': 'Tip: install the plugin marketplace dsh-plugin first, then browse every plugin from its UI instead of typing package names.',
        'plugins.spec.limits': 'A full path to a local plugin folder also works. Range specs such as ^1.0.0 are not supported, and local paths must not contain spaces.',
        'plugins.spec.placeholder': 'package name, e.g. dsh-plugin',
        'plugins.run': 'Run',
        'plugins.cancel': 'Cancel',
        'plugins.verify-note': 'A target confirmation is shown before any write. Discovery and browsing never write.',
        'plugins.step.running': 'Running',
        'plugins.step.post-check': 'Verifying',
        'plugins.step.done': 'Done',
        'plugins.step.failed': 'Failed',
        'plugins.step.cancelled': 'Cancelled',
        'plugins.output': 'Output',
        'plugins.handoff': 'Plugin change complete; restart Harness to enter the new Loader composition.',
        'plugins.restart-now': 'Restart now',
        'plugins.later': 'Later',
        'plugins.installed': 'Installed dependencies',
        'plugins.loaded': 'in Loader',
        'plugins.empty': '(empty)',
        'plugins.inventory-none': '(no profiles discovered — refresh in the Harness section first)',
        'plugins.recovery.pending': 'The last plugin change is waiting for restart verification.',
        'plugins.recovery.needed': 'A plugin change broke the Harness boot.',
        'plugins.recovery.drift': 'Profile files changed externally after the plugin change; auto-recovery stopped.',
        'plugins.recovery.recovered': 'The last plugin change failed to boot; the previous configuration was restored.',
        'plugins.recovery.restore': 'Restore previous plugin configuration',
        'plugins.recovery.abandon': 'Abandon recovery (keep current state)',
        'plugins.recovery.open-profile': 'Open profile folder',
        'nav.feedback': 'Bug Report & Diagnostics',
        'fb.prompt': 'What went wrong?',
        'fb.placeholder': 'Describe the problem you hit (save did nothing, launch failed, UI froze…). Say it first — after you send, the AI will triage and draft it for you.',
        'fb.send': 'Send to AI triage',
        'fb.sending': 'AI is triaging… (about 30 seconds at most; the result returns here, no need to click again)',
        'fb.degraded': 'AI triage is unavailable right now (Harness not running or recovering). A static issue template is pre-filled instead — sending still works.',
        'fb.diagnostics': 'Diagnostics bundle (auto-redacted, editable)',
        'fb.diagnostics.note': 'The bundle is auto-redacted at collection (usernames, paths, keys). Review and edit it here before sending or submitting.',
        'fb.reply': 'AI triage reply',
        'fb.issue-title': 'Issue preview',
        'fb.copy-open': 'Copy & open GitHub',
        'fb.gateway.submit': 'No GitHub? Send it to us directly',
        'fb.gateway.export': 'No GitHub? Export a feedback file',
        'diag.build-info': 'Build info',
        'diag.build.app': 'Version',
        'diag.build.dsh': 'Embedded Harness',
        'diag.build.runtime': 'Runtime',
        'diag.build.home': 'Harness home',
        'diag.build.profile': 'Active profile',
        'diag.build.status': 'Status',
        'diag.build.log': 'Log file',
        'diag.build.updated': 'Last update',
        'diag.last-exit.clean': 'Last exit: clean',
        'diag.last-exit.unclean': 'Last exit: unclean (evidence collected on this launch)',
        'diag.last-exit.unknown': 'Last exit: no history',
        'diag.open-log': 'Open log folder',
        'diag.export': 'Export diagnostics bundle',
        'diag.last-export': 'Last export: ',
        'diag.copy-path': 'Copy full path',
        'format.colon': ': ',
      },
    }

    // ---- 控制桥（main 的回环 HTTP；参数经页面 URL 下发，见 main.ts D39 段） ----

    function readBridge() {
      var match = /[?&]deepseekgui-control=([^&#]+)/.exec(window.location.search)
      if (match === null) return null
      var value = decodeURIComponent(match[1])
      var dot = value.indexOf('.')
      if (dot <= 0) return null
      var port = value.slice(0, dot)
      var token = value.slice(dot + 1)
      var base = 'http://127.0.0.1:' + port
      return {
        async model() {
          var r = await fetch(base + '/control/model', { headers: { 'x-deepseekgui-control-token': token } })
          if (!r.ok) throw new Error('HTTP ' + String(r.status))
          return (await r.json()).model
        },
        async run(command) {
          var r = await fetch(base + '/control/command', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-deepseekgui-control-token': token },
            body: JSON.stringify({ command: command }),
          })
          var body = await r.json().catch(function () { return {} })
          if (!r.ok) throw new Error(typeof body.error === 'string' ? body.error : 'HTTP ' + String(r.status))
          return body.model
        },
      }
    }

    // ---- 共享样式（官方 token；分区自绘内部，官方只给列容器） ----

    var S = {
      section: { display: 'flex', flexDirection: 'column', gap: '20px', fontSize: '14px', lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
      title: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' },
      row: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 },
      value: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      group: { display: 'flex', flexDirection: 'column', gap: '8px' },
      button: {
        padding: '5px 12px', borderRadius: '8px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent',
        color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: '20px',
      },
      buttonActive: { background: 'var(--dsw-alias-bg-multi-select)' },
      buttonDisabled: { opacity: 0.45, cursor: 'default' },
      input: {
        flex: '1 1 auto', minWidth: 0, padding: '5px 10px', borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent',
        color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: '20px',
      },
      note: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      warnBox: {
        display: 'flex', flexDirection: 'column', gap: '6px',
        padding: '10px 12px', borderRadius: '10px',
        border: '1px solid var(--dsw-alias-state-error-primary)',
        color: 'var(--dsw-alias-state-error-primary)',
        fontSize: '13px', lineHeight: '20px',
      },
      error: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-state-error-primary)', overflowWrap: 'anywhere' },
      output: {
        maxHeight: '220px', overflow: 'auto', margin: 0, padding: '10px 12px',
        borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-markdown-code-block)', font: 'var(--dsw-font-markdown-code-block-small)',
        whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
      },
    }

    /**
     * 分区里的按钮。`props.testId` 会落成 `data-deepseekgui` 属性——打包 e2e
     * 的唯一稳定抓手：文案随 locale 变、样式是内联对象、类名没有，只有这个
     * 属性是契约。加新按钮时请一并给 testId（tests-e2e/chrome-driver.ts 的
     * clickDeepSeekGUIButton 按它定位）。
     */
    function btn(props, label) {
      var disabled = props.disabled === true
      var style = Object.assign({}, S.button, props.active === true ? S.buttonActive : null, disabled ? S.buttonDisabled : null)
      return h('button', {
        type: 'button', style: style, disabled: disabled, key: props.key,
        'data-deepseekgui': props.testId,
        'data-deepseekgui-active': props.active === true ? 'true' : undefined,
        onClick: disabled ? undefined : props.onClick,
      }, label)
    }

    function labeled(t, key, node) {
      return h('div', { style: S.group }, h('div', { style: S.title }, t(key)), node)
    }

    /** 单行「标签：值」（住户 2026-08-23 验收定的紧凑格式；D29：冒号从字典取）。 */
    /**
     * 字典取值，缺键回退给定文本。
     *
     * 构建信息的行是 main 组装的，字典在插件这边——两侧版本万一不同步
     * （旧插件遇到新行），官方 locale 对未知键会把键名原样吐出来，界面上
     * 就会出现 `diag.build.xxx` 这种裸键。回退到那一行自带的英文 label：
     * 露一行英文比露一个内部键名强。
     * @param {(key: string) => string} t - 官方 locale 取值函数。
     * @param {string|undefined} key - 字典键。
     * @param {string} fallback - 回退文本。
     * @returns {string} 显示文本。
     */
    function dictText(t, key, fallback) {
      if (key === undefined || key === null || key === '') return fallback
      var text = t(key)
      return text === undefined || text === null || text === '' || text === key ? fallback : text
    }

    function line(label, value, title, colon, testId) {
      return h('div', { style: S.row, 'data-deepseekgui': testId },
        h('span', { style: S.title }, label + colon),
        h('span', { style: Object.assign({}, S.value), title: title }, value))
    }

    /** 模型轮询 + 命令执行的公共 hook（分区激活时才挂载 → 才轮询）。 */
    function useDesktopModel(bridge) {
      var state = React.useState(null)
      var model = state[0]; var setModel = state[1]
      var errorState = React.useState(null)
      var error = errorState[0]; var setError = errorState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]; var setBusy = busyState[1]
      var refresh = React.useCallback(function () {
        bridge.model().then(
          function (next) { setModel(next); setError(null) },
          function (cause) { setError(String(cause && cause.message || cause)) },
        )
      }, [])
      React.useEffect(function () {
        refresh()
        var id = setInterval(refresh, 2000)
        return function () { clearInterval(id) }
      }, [])
      var run = React.useCallback(function (command) {
        setBusy(true)
        bridge.run(command).then(
          function (next) { if (next) setModel(next); setError(null); setBusy(false) },
          function (cause) { setError(String(cause && cause.message || cause)); setBusy(false) },
        )
      }, [])
      return { model: model, error: error, busy: busy, run: run }
    }

    // ---- 分区一：Harness（桌面） ----

    function makeHarnessSection(bridge) {
      return function HarnessSection(props) {
        var t = props.t
        var d = useDesktopModel(bridge)
        if (d.model === null) {
          return h('div', { style: S.section },
            d.error === null ? h('div', { style: S.note }, t('bridge.loading')) : h('div', { style: S.error }, t('bridge.error'), d.error))
        }
        var m = d.model
        var busy = d.busy
        // status 是 {phase,...} 判别联合，不是字符串（首验收「status.[object
        // Object]」的教训）；running+recovered 拆成独立文案相。
        var phase = m.status.phase === 'running' && m.status.recovered === true ? 'recovered' : m.status.phase
        var statusText = t('status.' + phase) + (m.pending === null ? '' : '（' + t('harness.pending') + '：' + m.pending + '）')
        var homeLabel = m.homeKind === 'managed' ? t('harness.home.managed') : t('harness.home.existing')

        var profileRows
        if (m.profiles === null) {
          profileRows = [h('div', { style: S.note, key: 'none' }, t('profiles.not-discovered'))]
        } else if (m.profiles.length === 0) {
          profileRows = [h('div', { style: S.note, key: 'none' }, t('profiles.none'))]
        } else {
          profileRows = m.profiles.map(function (profile) {
            var marks = []
            if (profile.staticStatus === 'headless') marks.push(t('profile.headless'))
            if (profile.staticStatus === 'malformed') marks.push(t('profile.malformed'))
            if (profile.bootFailingStage !== undefined) marks.push(t('profile.boot-failing'))
            var switchable = profile.staticStatus !== 'headless' && profile.staticStatus !== 'malformed' && !profile.active
            return h('div', { style: S.row, key: profile.name },
              h('span', { style: S.value }, profile.name),
              profile.active ? h('span', { style: S.note }, '✓ ' + t('profile.active') + '（' + homeLabel + '）') : null,
              marks.length > 0 ? h('span', { style: S.note }, marks.join(' · ')) : null,
              switchable ? btn({ testId: 'profile-switch-' + profile.name, disabled: busy, onClick: function () { d.run({ type: 'switch-profile', profile: profile.name }) } }, t('profile.switch')) : null)
          })
        }

        var candidate = null
        if (m.existingHomeCandidate !== null) {
          var candidateRows = m.existingHomeCandidate.profiles
            .filter(function (profile) { return profile.staticStatus === 'web-capable' || profile.staticStatus === 'candidate' })
            .map(function (profile) {
              return h('div', { style: S.row, key: profile.name },
                h('span', { style: S.value }, profile.name),
                btn({ testId: 'candidate-profile-' + profile.name, disabled: busy, onClick: function () { d.run({ type: 'choose-existing-profile', profile: profile.name }) } }, t('profile.switch')))
            })
          candidate = labeled(t, 'candidate.title', h('div', { style: S.group },
            h('div', { style: S.note }, m.existingHomeCandidate.path),
            candidateRows.length > 0 ? candidateRows : h('div', { style: S.note }, t('candidate.none')),
            h('div', { style: S.row }, btn({ testId: 'candidate-cancel', disabled: busy, onClick: function () { d.run({ type: 'cancel-existing-home' }) } }, t('candidate.cancel')))))
        }

        var recovery = null
        if (m.recovery !== null) {
          recovery = labeled(t, 'recovery.title', h('div', { style: S.group, 'data-deepseekgui': 'harness-recovery' },
            h('div', { style: S.note }, t('recovery.stage') + '：' + m.recovery.stage),
            h('div', { style: S.note }, t('recovery.message') + '：' + m.recovery.message),
            h('div', { style: S.note }, t('recovery.recovered-to') + '：' + m.recovery.recoveredTo)))
        }

        var permission
        if (m.permissions.mode === 'unavailable') {
          permission = h('div', { style: S.note }, t('permission.unavailable'))
        } else {
          // read-only / custom 两种模式没有切换按钮语义，先如实展示 preset。
          permission = h('div', { style: S.group },
            h('div', { style: Object.assign({}, S.row, { flexWrap: 'wrap' }) },
              btn({ testId: 'permission-sandbox', active: m.permissions.mode === 'sandbox', disabled: busy || m.permissions.mode === 'sandbox', onClick: function () { d.run({ type: 'set-permission-mode', mode: 'sandbox' }) } }, t('permission.sandbox')),
              btn({ testId: 'permission-full-access', active: m.permissions.mode === 'full-access', disabled: busy || m.permissions.mode === 'full-access', onClick: function () { d.run({ type: 'set-permission-mode', mode: 'full-access' }) } }, t('permission.full-access')),
              m.permissions.mode !== 'sandbox' && m.permissions.mode !== 'full-access' && m.permissions.preset !== null
                ? h('span', { style: S.note }, m.permissions.mode + ' · ' + m.permissions.preset)
                : null),
            // 「你当前没在用推荐预设」——这句是 DeepSeekGUI 独有的提醒（官方那边
            // 不会说），面板迁进设置页时跟着旧 renderer 一起丢了，补回来。
            m.permissions.mode !== 'sandbox' && m.permissions.mode !== 'unavailable'
              ? h('div', { style: S.error, 'data-deepseekgui': 'permission-not-recommended' }, t('permission.not-recommended'))
              : null)
        }

        return h('div', { style: S.section },
          // 越线才出现，出现就在最上面：这是打开设置第一眼要看到的东西。
          // 只陈述事实与后果，不提供"一键清理"——删的是用户自己的对话，
          // 该由他在官方界面里逐个决定，而不是我们代劳。
          m.sessionPressure !== null
            ? h('div', { style: S.warnBox, 'data-deepseekgui': 'session-pressure' }, t('sessions.warn'))
            : null,
          d.error !== null ? h('div', { style: S.error }, t('bridge.error'), d.error) : null,
          busy ? h('div', { style: S.note }, t('busy')) : null,
          line(t('harness.status'), statusText, undefined, t('format.colon'), 'harness-status'),
          line(t('harness.location'), m.dshHome, m.dshHome, t('format.colon'), 'harness-location'),
          labeled(t, 'profiles.title', h('div', { style: S.group },
            m.discoveryError !== null ? h('div', { style: S.error }, t('profiles.discovery-failed'), m.discoveryError) : null,
            profileRows)),
          labeled(t, 'harness.permission', permission),
          // PS7 只影响用户自己的终端，绝不影响 Agent sandbox（P6-E）——提示
          // 随面板迁移丢过一次，补回来并让 powerShell7Available 重新有消费者。
          m.powerShell7Available === false ? h('div', { style: S.note, 'data-deepseekgui': 'term-ps7-note' }, t('term.ps7.note')) : null,
          candidate,
          recovery,
          // 终端入口刻意不在这里（住户定）：DSH 终端留在左上角 DeepSeekGUI 菜单。
          h('div', { style: Object.assign({}, S.row, { flexWrap: 'wrap' }) },
            btn({ testId: 'harness-refresh', disabled: busy, onClick: function () { d.run({ type: 'refresh-profiles' }) } }, t('action.refresh')),
            btn({ testId: 'harness-restart', disabled: busy, onClick: function () { d.run({ type: 'restart-harness' }) } }, t('action.restart')),
            btn({ testId: 'harness-choose-existing', disabled: busy, onClick: function () { d.run({ type: 'choose-existing-home' }) } }, t('action.choose-existing')),
            m.homeKind === 'existing' ? btn({ testId: 'harness-use-managed', disabled: busy, onClick: function () { d.run({ type: 'use-managed-home' }) } }, t('action.use-managed')) : null))
      }
    }

    // ---- 分区二：插件管理（本地） ----

    function makePluginsSection(bridge) {
      return function PluginsSection(props) {
        var t = props.t
        var d = useDesktopModel(bridge)
        var specState = React.useState('')
        var spec = specState[0]; var setSpec = specState[1]
        var actionState = React.useState('add')
        var action = actionState[0]; var setAction = actionState[1]
        if (d.model === null) {
          return h('div', { style: S.section },
            d.error === null ? h('div', { style: S.note }, t('bridge.loading')) : h('div', { style: S.error }, t('bridge.error'), d.error))
        }
        var m = d.model
        var pm = m.pluginManager
        var busy = d.busy
        var names = pm.profiles.map(function (entry) { return entry.name })
        // 单 profile 现状（住户定）：目标区整块不显示，写操作永远落在
        // active profile；多 profile 的目标选择等 B3 Workbench 一并回来。
        var effectiveTarget = names.indexOf(m.activeProfile) >= 0 ? m.activeProfile : names[0]
        var needsSpec = action !== 'install'
        // 忙碌判据必须与 main 的 requestPluginOperation 一致：只有**运行中 /
        // 验证中**挡住新请求，终态（done/failed/cancelled）允许发起下一次
        // （main 的原话：「终态允许开始下一次操作（先清掉旧视图）」）。
        // 写成 `operation === null` 会把「这一轮里操作过一次」也算成忙——
        // 装完一个插件想再装或删第二个时，执行钮是灰的，只能重启 DeepSeekGUI。
        // P8-D39 迁移时收严了这个条件；同一段里取消钮用的判据反而是对的。
        // 2026-08-24 由 plugin-manager 的 remove 步骤抓出（60 秒等满，执行钮
        // 始终禁用）。
        var opBusy = pm.operation !== null
          && (pm.operation.step === 'running' || pm.operation.step === 'post-check')
        var canRun = !busy && !opBusy && effectiveTarget !== undefined && (!needsSpec || spec.trim() !== '')

        var opBlock = null
        if (pm.operation !== null) {
          var op = pm.operation
          var running = op.step === 'running' || op.step === 'post-check'
          opBlock = h('div', { style: S.group },
            h('div', { style: S.row, 'data-deepseekgui': 'plugin-operation' },
              h('span', null, t('plugins.action.' + op.action) + ' · ' + op.profile + (op.spec === null ? '' : ' · ' + op.spec)),
              h('span', { style: S.note }, t('plugins.step.' + op.step)),
              running ? btn({ testId: 'plugin-op-cancel', disabled: busy, onClick: function () { d.run({ type: 'plugin-op-cancel' }) } }, t('plugins.cancel')) : null),
            op.message !== null ? h('div', { style: S.note }, op.message) : null,
            op.postCheck !== null ? h('div', { style: S.note }, op.postCheck.evidence) : null,
            op.output.length > 0 ? h('pre', { style: S.output, 'data-deepseekgui': 'plugin-operation-output' }, op.output.join('\n')) : null)
        }

        var handoff = null
        if (pm.handoffPending) {
          handoff = h('div', { style: S.group },
            h('div', { style: S.note }, t('plugins.handoff')),
            h('div', { style: S.row },
              btn({ testId: 'plugin-handoff-restart', disabled: busy, onClick: function () { d.run({ type: 'plugin-handoff-restart' }) } }, t('plugins.restart-now')),
              btn({ testId: 'plugin-handoff-later', disabled: busy, onClick: function () { d.run({ type: 'plugin-handoff-later' }) } }, t('plugins.later'))))
        }

        var recovery = null
        if (pm.recovery !== null) {
          var recoveryKey = pm.recovery.state === 'drift' ? 'plugins.recovery.drift'
            : pm.recovery.state === 'recovery-needed' ? 'plugins.recovery.needed'
              : pm.recovery.state === 'recovered' ? 'plugins.recovery.recovered' : 'plugins.recovery.pending'
          recovery = h('div', { style: S.group, 'data-deepseekgui': 'plugin-recovery-block' },
            h('div', { style: S.error }, t(recoveryKey) + '（' + pm.recovery.profile + '）'),
            pm.recovery.failure !== null ? h('div', { style: S.note }, pm.recovery.failure) : null,
            h('div', { style: Object.assign({}, S.row, { flexWrap: 'wrap' }) },
              // Restore 只在 recovery-needed 时给。drift 意味着白名单文件被
              // 外部改过，快照已经不能安全覆盖回去——后端 runRecoveryRestore
              // 也正是这么 fail closed 的（state !== 'recovery-needed' 直接
              // return）。UI 再摆一个点了毫无反应的按钮，用户只会以为坏了。
              // P8-D39 把恢复区从 chrome 面板搬进设置页时漏掉了这个条件，
              // 2026-08-24 六套件跑齐时由 S10b 抓出来。
              pm.recovery.state === 'recovery-needed'
                ? btn({ testId: 'plugin-recovery-restore', disabled: busy, onClick: function () { d.run({ type: 'plugin-recovery-restore' }) } }, t('plugins.recovery.restore'))
                : null,
              btn({ testId: 'plugin-recovery-abandon', disabled: busy, onClick: function () { d.run({ type: 'plugin-recovery-abandon' }) } }, t('plugins.recovery.abandon')),
              btn({ testId: 'plugin-recovery-open-profile', disabled: busy, onClick: function () { d.run({ type: 'plugin-recovery-open-profile' }) } }, t('plugins.recovery.open-profile'))))
        }

        var inventory
        if (pm.profiles.length === 0) {
          inventory = h('div', { style: S.note }, t('plugins.inventory-none'))
        } else {
          inventory = pm.profiles.map(function (entry) {
            var deps = entry.inventory.dependencies
            return h('div', { style: S.group, key: entry.name, 'data-deepseekgui': 'plugin-inventory-' + entry.name },
              h('div', { style: S.title }, entry.name + (entry.name === m.activeProfile ? ' ✓' : '')),
              entry.inventory.manifestError !== null ? h('div', { style: S.error }, entry.inventory.manifestError) : null,
              deps.length === 0
                ? h('div', { style: S.note }, t('plugins.empty'))
                : deps.map(function (dep) {
                  return h('div', { style: S.row, key: dep.name },
                    h('span', { style: S.value }, dep.name + (dep.spec ? ' @ ' + dep.spec : '')),
                    dep.inBundles === true ? h('span', { style: S.note }, t('plugins.loaded')) : null)
                }))
          })
        }

        var actions = ['add', 'remove', 'update', 'install']
        return h('div', { style: S.section },
          d.error !== null ? h('div', { style: S.error }, t('bridge.error'), d.error) : null,
          pm.error !== null ? h('div', { style: S.error }, pm.error) : null,
          labeled(t, 'plugins.action', h('div', { style: Object.assign({}, S.row, { flexWrap: 'wrap' }) },
            actions.map(function (id) {
              return btn({ key: id, testId: 'plugin-action-' + id, active: action === id, disabled: busy, onClick: function () { setAction(id) } }, t('plugins.action.' + id))
            }))),
          needsSpec
            ? h('div', { style: S.group },
              h('div', { style: S.note }, t('plugins.spec.hint')),
              h('input', {
                style: S.input, 'data-deepseekgui': 'plugin-spec', value: spec, placeholder: t('plugins.spec.placeholder'),
                onChange: function (event) { setSpec(event.target.value) },
              }),
              // 住户 2026-08-27 定的「矛盾转移」：与其在这里教用户 pnpm 的写法，
              // 不如引导他装一次插件市场——装完既学会了这个输入框，也从此有了
              // 图形化的插件浏览界面，不用再回来手打包名。
              action === 'add' ? h('div', { style: S.note }, t('plugins.spec.market')) : null,
              h('div', { style: S.note }, t('plugins.spec.limits')))
            : null,
          h('div', { style: S.row },
            btn({ testId: 'plugin-run', disabled: !canRun, onClick: function () {
              d.run({ type: 'plugin-op-request', action: action, profile: effectiveTarget, spec: needsSpec ? spec.trim() : null })
            } }, t('plugins.run'))),
          h('div', { style: S.note, 'data-deepseekgui': 'plugin-verify-note' }, t('plugins.verify-note')),
          opBlock,
          handoff,
          recovery,
          labeled(t, 'plugins.installed', h('div', { style: S.group }, inventory)))
      }
    }

    // ---- 分区三：BUG 诊断与反馈（chrome 面板移植；命令与 main 同一出口） ----

    function makeFeedbackSection(bridge) {
      return function FeedbackSection(props) {
        var t = props.t
        var d = useDesktopModel(bridge)
        var textState = React.useState('')
        var text = textState[0]; var setText = textState[1]
        var diagState = React.useState(null)
        var diagDraft = diagState[0]; var setDiagDraft = diagState[1]
        // 进入分区 = 打开反馈（main 借此收集脱敏诊断包）；离开 = 关闭。
        React.useEffect(function () {
          d.run({ type: 'open-feedback' })
          return function () { d.run({ type: 'close-feedback' }) }
        }, [])
        if (d.model === null) {
          return h('div', { style: S.section },
            d.error === null ? h('div', { style: S.note }, t('bridge.loading')) : h('div', { style: S.error }, t('bridge.error'), d.error))
        }
        var m = d.model
        var view = m.feedback
        var busy = d.busy
        var sending = view.phase === 'sending'
        var settled = view.phase === 'replied' || view.phase === 'degraded'
        var diagValue = diagDraft === null ? view.diagnostics : diagDraft

        var result = null
        if (settled) {
          result = h('div', { style: S.group },
            view.phase === 'degraded' ? h('div', { style: S.note }, t('fb.degraded')) : null,
            view.phase === 'replied' && view.reply !== null
              ? h('div', { style: S.group }, h('div', { style: S.title }, t('fb.reply')), h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, view.reply))
              : null,
            h('div', { style: S.title }, t('fb.issue-title')),
            h('div', null, view.issueTitle),
            h('div', { style: Object.assign({}, S.row, { flexWrap: 'wrap' }) },
              btn({ testId: 'feedback-copy-open', disabled: busy, onClick: function () { d.run({ type: 'feedback-copy-open' }) } }, t('fb.copy-open')),
              btn({ testId: 'feedback-submit-gateway', disabled: busy, onClick: function () { d.run({ type: 'feedback-submit-gateway' }) } }, t(view.gatewayConfigured ? 'fb.gateway.submit' : 'fb.gateway.export'))),
            view.notice !== null ? h('div', { style: S.note }, view.notice) : null)
        }

        var lastExitKey = m.diagnostics.uncleanExit === true ? 'diag.last-exit.unclean'
          : m.diagnostics.uncleanExit === false ? 'diag.last-exit.clean' : 'diag.last-exit.unknown'

        return h('div', { style: S.section },
          d.error !== null ? h('div', { style: S.error }, t('bridge.error'), d.error) : null,
          h('div', { style: S.group },
            h('div', { style: S.title }, t('fb.prompt')),
            h('textarea', {
              'data-deepseekgui': 'feedback-text',
              style: Object.assign({}, S.input, { minHeight: '72px', resize: 'vertical', fontFamily: 'inherit' }),
              value: text, placeholder: t('fb.placeholder'),
              onChange: function (event) { setText(event.target.value) },
            }),
            h('div', { style: S.row },
              btn({ testId: 'feedback-send', disabled: sending || busy || text.trim() === '', onClick: function () {
                d.run({ type: 'feedback-send', text: text.trim(), diagnostics: diagValue })
              } }, t(sending ? 'fb.sending' : 'fb.send')))),
          h('details', null,
            h('summary', { style: S.title }, t('fb.diagnostics')),
            h('div', { style: S.note }, t('fb.diagnostics.note')),
            h('textarea', {
              'data-deepseekgui': 'feedback-diagnostics',
              style: Object.assign({}, S.input, { minHeight: '120px', resize: 'vertical', fontFamily: 'var(--dsw-font-family-mono, monospace)' }),
              value: diagValue,
              onChange: function (event) { setDiagDraft(event.target.value) },
            })),
          result,
          h('div', { style: S.group },
            h('div', { style: S.title, 'data-deepseekgui': 'diag-build-info' }, t('diag.build-info')),
            // exportOnly 的行只进导出文本，不上界面（更新通道那种「我们的
            // 发行事实」对用户没有可操作性）。标签与部分值走字典；字典缺
            // 键时回退英文 label，宁可露一行英文也不显示一个裸键。
            m.diagnostics.buildInfo.filter(function (row) {
              return row.exportOnly !== true
            }).map(function (row) {
              var label = dictText(t, row.key, row.label)
              var value = row.valueKey === undefined ? row.value : dictText(t, row.valueKey, row.value)
              // 显示打码值，title（悬停）给原值：截图截不到悬停内容。
              return line(label, value, row.exportValue === undefined ? row.value : row.exportValue, t('format.colon'))
            }),
            h('div', { style: S.note }, t(lastExitKey)),
            line(t('harness.location'), m.diagnostics.homeDisplay, m.dshHome, t('format.colon'))),
          h('div', { style: Object.assign({}, S.row, { flexWrap: 'wrap' }) },
            btn({ testId: 'diag-copy-path', disabled: busy, onClick: function () { d.run({ type: 'copy-full-path' }) } }, t('diag.copy-path')),
            btn({ testId: 'diag-open-log', disabled: busy, onClick: function () { d.run({ type: 'open-log-folder' }) } }, t('diag.open-log')),
            btn({ testId: 'diag-export', disabled: busy, onClick: function () { d.run({ type: 'export-diagnostics' }) } }, t('diag.export'))),
          m.diagnostics.lastExport !== null ? h('div', { style: S.note }, t('diag.last-export') + m.diagnostics.lastExport) : null)
      }
    }

    /** 装载：控制桥参数在场才注册分区（外部浏览器打开 3080 时不在场）。 */
    var inject = ['slots', 'locale']
    function apply(ctx) {
      // 整体兜底：本插件坏了只能表现为「设置页少了 DeepSeekGUI 分区」，绝不许
      // 把整轮 composition 拖死在 boot（D31 的失败形状）。Chrome 菜单是同一
      // 命令出口的另一入口，功能不因此丢失。
      try {
        applyInner(ctx)
      } catch (error) {
        console.error('[deepseekgui-settings] apply failed: ' + String(error && error.message || error))
      }
    }
    /**
     * 会话头部 utilities 区的浏览器面板开关（B3-11 返工：住户定——产品内
     * 功能按钮住在产品内容区，与 Session log 并排，不占应用整体顶栏）。
     * 无状态：点击即 toggle，开合事实由壳持有（与菜单项同一命令出口）。
     */
    function makeBrowserPaneButton(bridge, t) {
      return function BrowserPaneButton() {
        var busyState = React.useState(false)
        var busy = busyState[0]
        var setBusy = busyState[1]
        return h('button', {
          type: 'button',
          title: t('browser.toggle'),
          'aria-label': t('browser.toggle'),
          disabled: busy,
          onClick: function () {
            setBusy(true)
            bridge.run({ type: 'browser-pane-toggle' })
              .catch(function () { /* 壳不在或桥断：按钮静默失败，无第二事实源可撒谎 */ })
              .then(function () { setBusy(false) })
          },
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '36px',
            height: '36px',
            padding: '0',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: '999px',
            background: 'var(--dsw-alias-bg-base)',
            color: 'var(--dsw-alias-label-secondary)',
            cursor: busy ? 'default' : 'pointer',
          },
        }, h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
          h('circle', { cx: 8, cy: 8, r: 6.4, stroke: 'currentColor', strokeWidth: 1.3 }),
          h('ellipse', { cx: 8, cy: 8, rx: 2.9, ry: 6.4, stroke: 'currentColor', strokeWidth: 1.1 }),
          h('path', { d: 'M1.9 5.7h12.2M1.9 10.3h12.2', stroke: 'currentColor', strokeWidth: 1.1 })))
      }
    }

    function applyInner(ctx) {
      var bridge = readBridge()
      if (bridge === null) return
      ctx.effect(function () { return ctx.locale.register(NS, STRINGS) }, 'deepseekgui-settings: dictionaries')
      var t = ctx.locale.bind(NS)
      var HarnessSection = makeHarnessSection(bridge)
      var PluginsSection = makePluginsSection(bridge)
      var FeedbackSection = makeFeedbackSection(bridge)
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'deepseekgui-harness',
          order: 40,
          label: function () { return t('nav.harness') },
          locale: NS,
        }, HarnessSection)
      })
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'deepseekgui-plugins',
          order: 41,
          label: function () { return t('nav.plugins') },
          locale: NS,
        }, PluginsSection)
      })
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'deepseekgui-feedback',
          order: 42,
          label: function () { return t('nav.feedback') },
          locale: NS,
        }, FeedbackSection)
      })
      // 浏览器面板开关：会话头部 utilities（Session log 同排，B3-11 返工）。
      var BrowserPaneButton = makeBrowserPaneButton(bridge, t)
      ctx.slots.inject('conversation.session.header.utilities', function () {
        return ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'deepseekgui-browser-pane',
          order: 110,
          label: function () { return t('browser.toggle') },
          locale: NS,
        }, BrowserPaneButton)
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
