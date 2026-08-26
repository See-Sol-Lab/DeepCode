/**
 * 封闭命令联合的调度器：每条 DesktopControlCommand 只调用对应的现有
 * controller/discovery 路径，绝不直接 spawn、绝不直接写 launcher state。
 * 依赖全部注入（controller 端口、只读 discover、目录选择、退出、缓存
 * 持有者、模型推送），main 只做接线；单元测试注入 fake 验证
 * "命令 → 唯一路径" 与 Existing Home 两段式零写入语义。
 * @module @see-sol-lab/deepcode/control-dispatch
 */

import type { DesktopControlCommand } from './control-model.ts'
import type { HarnessStatus } from './harness-controller.ts'
import { redactSecrets } from './redact.ts'
import { sameHarnessSelection } from './launcher-state.ts'
import type { HarnessSelection, LauncherStateV1 } from './launcher-state.ts'
import type { ProfileDiscoveryV1 } from './profile-discovery.ts'
import type { PluginAction } from './plugin-service.ts'

/** controller 暴露给调度器的最小端口（HarnessController 天然满足）。 */
export interface DispatchControllerPort {
  status(): HarnessStatus
  switchTo(selection: HarnessSelection): Promise<void>
  restart(): Promise<void>
}

/** discovery 结果缓存与 Existing Home 候选（main 持有，renderer 只读快照）。 */
export interface ControlStateHolder {
  discovery: ProfileDiscoveryV1 | null
  discoveryError: string | null
  existingHomeCandidate: { path: string; discovery: ProfileDiscoveryV1 } | null
}

/** 调度器依赖注入面。 */
export interface ControlDispatchDeps {
  /** 读取当前界面是否使用中文。 */
  zh?: () => boolean
  controller: DispatchControllerPort
  /** 读取 launcher state（磁盘权威）。 */
  readState: () => LauncherStateV1
  /** 把 active home 解析为绝对 DSH_HOME。 */
  resolveActiveHome: (state: LauncherStateV1) => string
  /** 对指定 DSH_HOME 做只读 discovery。 */
  discover: (dshHome: string) => Promise<ProfileDiscoveryV1>
  /** 原生目录选择；取消返回 null。 */
  pickDirectory: () => Promise<string | null>
  /**
   * 记录接管的 Existing Home 与自带 DSH runtime 之间的版本差异。
   *
   * 只在目标 Profile 真正晋升成功后调用一次——切换失败会回退到旧 Home，
   * 那时记录的是一个并没有在跑的 Home，只会误导读它的人。可选：调度器
   * 的测试关心的是切换语义，不该被迫提供一个诊断出口。
   */
  recordRuntimeSkew?: (homePath: string, profile: string) => void
  /**
   * 会打断运行中会话的动作的确认出口（切换 Profile / 重启 Harness /
   * 切回托管 Home）。只有 Harness 真的在跑、真的有东西会丢时才会被问
   * 到；返回 false = 用户取消，调度器必须原样退出，绝不留下半个动作。
   */
  confirmDisruptive: (action:
    | { kind: 'switch-profile'; profile: string }
    | { kind: 'restart-harness' }
    | { kind: 'use-managed-home' }
    // 接管既有 Home：与上面三者同等杀伤力（同样杀整个进程树），最初漏了门铃
    // ——四条路里三条有、唯独这条没有（P8-D26，DS 第 12 扇窗走查抓获）。
    | { kind: 'choose-existing-home'; profile: string },
  ) => Promise<boolean>
  /** 恢复详情对话框出口（show-recovery-details 命令）。 */
  showRecoveryDialog: () => void
  /** 恢复提示确认出口（acknowledge-recovery 命令）。 */
  acknowledgeRecovery: () => void
  /** 复制完整路径出口（copy-full-path 命令；renderer 无剪贴板权限）。 */
  copyFullPath: () => void
  /** 关于面板出口（show-about 命令）。 */
  showAbout: () => void
  /** DSH Terminal 出口（show-terminal 命令）。 */
  showTerminal: () => void
  /** Plugin Manager 写操作请求出口（确认 + 执行由 main 接线）。 */
  requestPluginOperation: (request: { action: PluginAction; profile: string; spec: string | null }) => void
  /** 取消当前 plugin 操作（杀完整 child tree）。 */
  cancelPluginOperation: () => void
  /** restart handoff 的 Restart Now（复用 controller.restart 唯一路径）。 */
  restartForPluginHandoff: () => void
  /** restart handoff 的 Later（关闭提示，绝不伪造已加载）。 */
  ackPluginHandoff: () => void
  /** Plugin Mutation Recovery：执行恢复（确认与执行由 main 接线）。 */
  pluginRecoveryRestore: () => void
  /** Plugin Mutation Recovery：放弃恢复（保留当前磁盘状态，清除事务）。 */
  pluginRecoveryAbandon: () => void
  /** Plugin Mutation Recovery：打开目标 Profile 文件夹（人工处理入口）。 */
  pluginRecoveryOpenProfile: () => void
  /** Update service 出口（Manual Check；background 由 main 自行调度）。 */
  checkForUpdates: () => void
  /** 关闭 available/verified 面板状态。 */
  updateDismiss: () => void
  /** 下载前确认 + 下载执行（main 接线）。 */
  updateDownload: () => void
  /** 取消进行中的下载。 */
  updateCancelDownload: () => void
  /** installer handoff 确认 + 执行。 */
  updateInstall: () => void
  /** Diagnostics：打开日志文件夹。 */
  openLogFolder: () => void
  /** Diagnostics：导出 bundle（本地目录，绝不上传）。 */
  exportDiagnostics: () => void
  /** 权限模式切换出口（sandbox / full-access；确认与官方写入由 main 接线）。 */
  setPermissionMode: (mode: 'sandbox' | 'full-access') => void
  /** Feedback：打开面板并收集诊断包（进程内，脱敏在收集点完成）。 */
  openFeedback: () => void
  /** Feedback：关闭面板。 */
  closeFeedback: () => void
  /** Feedback：发送用户问题与（可能被编辑过的）诊断包给 AI 排查；不可用走降级，绝不拒绝。 */
  sendFeedback: (text: string, diagnostics: string) => void
  /** Feedback：issue 正文进剪贴板 + 打开 GitHub issue 页（零后端零 Token）。 */
  feedbackCopyOpen: () => void
  /** Feedback（P8-D32）：无 GitHub 通道——网关直传，未配置/失败降级导出文件。 */
  feedbackSubmitGateway: () => void
  /** 内置浏览器 pane 开合（B3-11；pane 未创建时 no-op）。 */
  browserPaneToggle: () => void
  /** 退出应用。 */
  quit: () => void
  /** 缓存与候选的持有者。 */
  holder: ControlStateHolder
  /** 推送最新 ControlModel。 */
  broadcast: () => void
}

/**
 * 创建命令调度器。
 * @param deps - 依赖注入面。
 * @returns 处理一条已验证命令的函数。
 */
export function createControlDispatcher(deps: ControlDispatchDeps): (command: DesktopControlCommand) => Promise<void> {
  const refreshDiscovery = async (): Promise<void> => {
    const state = deps.readState()
    try {
      deps.holder.discovery = await deps.discover(deps.resolveActiveHome(state))
      deps.holder.discoveryError = null
    } catch (error) {
      deps.holder.discovery = null
      deps.holder.discoveryError = redactSecrets(error instanceof Error ? error.message : String(error))
    }
    deps.broadcast()
  }

  return async (command) => {
    switch (command.type) {
      case 'refresh-profiles':
        await refreshDiscovery()
        return
      case 'switch-profile': {
        const state = deps.readState()
        // 点已激活且正在运行的 profile 是 no-op：无谓重启只会白丢会话。
        if (state.active.profile === command.profile && deps.controller.status().phase === 'running') return
        // 切换会重启 Harness，正在跑的会话当场没了。只在**真的有东西会丢**
        // 时才拦一下（running 才问；停着或起不来时问用户毫无意义，
        // 确认框一旦变成噪音就没人看了）。
        if (deps.controller.status().phase === 'running' && !await deps.confirmDisruptive({
          kind: 'switch-profile', profile: command.profile,
        })) return
        await deps.controller.switchTo({ home: state.active.home, profile: command.profile })
        deps.broadcast()
        return
      }
      case 'choose-existing-home': {
        const dir = await deps.pickDirectory()
        // 取消目录选择零写入、零状态。
        if (dir === null) return
        const discovery = await deps.discover(dir)
        deps.holder.existingHomeCandidate = { path: dir, discovery }
        deps.broadcast()
        return
      }
      case 'choose-existing-profile': {
        const candidate = deps.holder.existingHomeCandidate
        if (candidate === null) throw new Error((deps.zh?.() ?? true) ? '没有待确认的 Existing Home 候选' : 'There is no pending Existing Home candidate')
        const target = candidate.discovery.profiles.find(profile => profile.name === command.profile)
        if (target === undefined || (target.staticStatus !== 'web-capable' && target.staticStatus !== 'candidate')) {
          throw new Error((deps.zh?.() ?? true)
            ? `候选 Home 中没有可启动的 profile ${JSON.stringify(command.profile)}`
            : `The candidate Home has no startable profile named ${JSON.stringify(command.profile)}`)
        }
        const selection: HarnessSelection = {
          home: { kind: 'existing', path: candidate.path },
          profile: command.profile,
        }
        // 接管既有 Home 与切换 Profile 的杀伤力完全一样（杀整个进程树），门铃
        // 的条件也必须一样：只在 running 时问（P8-D26）。
        //
        // 位置有讲究：**问在清空候选之前**。用户点「取消」时候选要原样留着，
        // 他多半只是想换一个 profile 再来一次；清空了他就得从选目录重走。
        if (deps.controller.status().phase === 'running' && !await deps.confirmDisruptive({
          kind: 'choose-existing-home', profile: command.profile,
        })) return
        deps.holder.existingHomeCandidate = null
        await deps.controller.switchTo(selection)
        // `running` 不等于目标晋升成功：切换失败后 lastKnownGood 回退也
        // 是 running（recovered），此时磁盘 active 已回到旧 Home。候选的
        // discovery 只有在目标真正晋升（非 recovered 且持久化 active 与
        // 请求一致）时才能复用；否则缓存属于实际 active Home，必须按
        // 磁盘事实重新只读 discovery。
        const status = deps.controller.status()
        if (
          status.phase === 'running'
          && !status.recovered
          && sameHarnessSelection(deps.readState().active, selection)
        ) {
          deps.recordRuntimeSkew?.(candidate.path, command.profile)
          deps.holder.discovery = candidate.discovery
          deps.holder.discoveryError = null
          deps.broadcast()
          return
        }
        deps.holder.discovery = null
        deps.holder.discoveryError = null
        await refreshDiscovery()
        return
      }
      case 'cancel-existing-home':
        deps.holder.existingHomeCandidate = null
        deps.broadcast()
        return
      case 'use-managed-home': {
        const state = deps.readState()
        // 点已激活且正在运行的 Managed/web 是 no-op：与 switch-profile 的
        // "点当前项不重启"对称——无谓重启只会白丢会话。
        if (state.active.home.kind === 'managed' && state.active.profile === 'web'
          && deps.controller.status().phase === 'running') return
        // 换 Home 与换 Profile 的杀伤力完全一样（杀整个进程树）：只在
        // 真的有东西会丢时才拦一下（running 才问，其余状态问等于噪音）。
        if (deps.controller.status().phase === 'running' && !await deps.confirmDisruptive({
          kind: 'use-managed-home',
        })) return
        await deps.controller.switchTo({ home: { kind: 'managed' }, profile: 'web' })
        // 切回 Managed：旧 Home 的缓存失效，清空后立即对 Managed 做一次只读 refresh。
        deps.holder.discovery = null
        deps.holder.discoveryError = null
        await refreshDiscovery()
        return
      }
      case 'restart-harness':
        // 同上：只有正在跑才有会话可丢，也才值得拦一下。
        if (deps.controller.status().phase === 'running'
          && !await deps.confirmDisruptive({ kind: 'restart-harness' })) return
        await deps.controller.restart()
        deps.broadcast()
        return
      case 'show-recovery-details':
        deps.showRecoveryDialog()
        return
      case 'acknowledge-recovery':
        deps.acknowledgeRecovery()
        return
      case 'copy-full-path':
        deps.copyFullPath()
        return
      case 'show-about':
        deps.showAbout()
        return
      case 'show-terminal':
        deps.showTerminal()
        return
      case 'plugin-op-request':
        deps.requestPluginOperation({ action: command.action, profile: command.profile, spec: command.spec })
        return
      case 'plugin-op-cancel':
        deps.cancelPluginOperation()
        return
      case 'plugin-handoff-restart':
        deps.restartForPluginHandoff()
        return
      case 'plugin-handoff-later':
        deps.ackPluginHandoff()
        return
      case 'plugin-recovery-restore':
        deps.pluginRecoveryRestore()
        return
      case 'plugin-recovery-abandon':
        deps.pluginRecoveryAbandon()
        return
      case 'plugin-recovery-open-profile':
        deps.pluginRecoveryOpenProfile()
        return
      case 'check-for-updates':
        deps.checkForUpdates()
        return
      case 'update-dismiss':
        deps.updateDismiss()
        return
      case 'update-download':
        deps.updateDownload()
        return
      case 'update-cancel-download':
        deps.updateCancelDownload()
        return
      case 'update-install':
        deps.updateInstall()
        return
      case 'open-log-folder':
        deps.openLogFolder()
        return
      case 'export-diagnostics':
        deps.exportDiagnostics()
        return
      case 'set-permission-mode':
        deps.setPermissionMode(command.mode)
        return
      case 'open-feedback':
        deps.openFeedback()
        return
      case 'close-feedback':
        deps.closeFeedback()
        return
      case 'feedback-send':
        deps.sendFeedback(command.text, command.diagnostics)
        return
      case 'feedback-copy-open':
        deps.feedbackCopyOpen()
        return
      case 'feedback-submit-gateway':
        deps.feedbackSubmitGateway()
        return
      case 'browser-pane-toggle':
        deps.browserPaneToggle()
        return
      case 'quit':
        deps.quit()
        return
      default:
        command satisfies never
    }
  }
}
