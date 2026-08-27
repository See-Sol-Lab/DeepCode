/**
 * Desktop Chrome 的窄 preload：只暴露具名 deepseekGUIDesktop API，不暴露
 * 通用 send/任意 IPC。sandbox: true 下 preload 必须是 CommonJS（.cts →
 * .cjs）。命令载荷原样交给 main 的 parseControlCommand 做边界验证；
 * 这里不做业务判断。
 * @module @see-sol-lab/deepseekgui/chrome/preload
 */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('deepseekGUIDesktop', {
  /** 当前 ControlModel 快照。 */
  getControlModel: (): Promise<unknown> => ipcRenderer.invoke('deepseekgui:get-control-model'),
  /** 执行一条封闭联合命令；非法命令被 main 明确拒绝（reject）。 */
  runControlCommand: (command: unknown): Promise<void> => ipcRenderer.invoke('deepseekgui:run-control-command', command),
  /**
   * 订阅 ControlModel 推送。
   * @returns 取消订阅函数。
   */
  onControlModelChanged: (listener: (model: unknown) => void): (() => void) => {
    const wrapped = (_event: unknown, model: unknown): void => {
      listener(model)
    }
    ipcRenderer.on('deepseekgui:control-model-changed', wrapped)
    return () => {
      ipcRenderer.removeListener('deepseekgui:control-model-changed', wrapped)
    }
  },
  /** 菜单开合时请求 main 调整 Chrome view bounds（顶栏高 ↔ 全窗覆盖）。 */
  setChromeExpanded: (expanded: boolean): Promise<void> => ipcRenderer.invoke('deepseekgui:set-chrome-expanded', expanded === true),
  /**
   * 订阅"打开更新面板"请求（Tray 的 Check for Updates 经此到达）。
   * Harness/反馈面板的订阅已随 P8-D39 移除：那些面板移居官方设置页，
   * Chrome 不再有可打开的对应容器。
   * @returns 取消订阅函数。
   */
  onOpenUpdatePanel: (listener: () => void): (() => void) => {
    const wrapped = (): void => {
      listener()
    }
    ipcRenderer.on('deepseekgui:open-update-panel', wrapped)
    return () => {
      ipcRenderer.removeListener('deepseekgui:open-update-panel', wrapped)
    }
  },
})
