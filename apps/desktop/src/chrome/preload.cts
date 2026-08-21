/**
 * Desktop Chrome 的窄 preload：只暴露具名 deepCodeDesktop API，不暴露
 * 通用 send/任意 IPC。sandbox: true 下 preload 必须是 CommonJS（.cts →
 * .cjs）。命令载荷原样交给 main 的 parseControlCommand 做边界验证；
 * 这里不做业务判断。
 * @module @see-sol-lab/deepcode/chrome/preload
 */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('deepCodeDesktop', {
  /** 当前 ControlModel 快照。 */
  getControlModel: (): Promise<unknown> => ipcRenderer.invoke('deepcode:get-control-model'),
  /** 执行一条封闭联合命令；非法命令被 main 明确拒绝（reject）。 */
  runControlCommand: (command: unknown): Promise<void> => ipcRenderer.invoke('deepcode:run-control-command', command),
  /**
   * 订阅 ControlModel 推送。
   * @returns 取消订阅函数。
   */
  onControlModelChanged: (listener: (model: unknown) => void): (() => void) => {
    const wrapped = (_event: unknown, model: unknown): void => {
      listener(model)
    }
    ipcRenderer.on('deepcode:control-model-changed', wrapped)
    return () => {
      ipcRenderer.removeListener('deepcode:control-model-changed', wrapped)
    }
  },
  /** 菜单开合时请求 main 调整 Chrome view bounds（顶栏高 ↔ 全窗覆盖）。 */
  setChromeExpanded: (expanded: boolean): Promise<void> => ipcRenderer.invoke('deepcode:set-chrome-expanded', expanded === true),
  /**
   * 订阅"打开 Harness 面板"请求（Tray 的 Open Harness Panel 经此到达）。
   * @returns 取消订阅函数。
   */
  onOpenHarnessPanel: (listener: () => void): (() => void) => {
    const wrapped = (): void => {
      listener()
    }
    ipcRenderer.on('deepcode:open-harness-panel', wrapped)
    return () => {
      ipcRenderer.removeListener('deepcode:open-harness-panel', wrapped)
    }
  },
  /** 订阅"打开诊断面板"请求（Tray 的 Check for Updates 经此到达）。 */
  onOpenDiagnosticsPanel: (listener: () => void): (() => void) => {
    const wrapped = (): void => {
      listener()
    }
    ipcRenderer.on('deepcode:open-diagnostics-panel', wrapped)
    return () => {
      ipcRenderer.removeListener('deepcode:open-diagnostics-panel', wrapped)
    }
  },
})
