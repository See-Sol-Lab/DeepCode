/**
 * DSH Terminal 的窄 preload：只暴露 deepseekGUITerminal 的具名 API，
 * 不暴露通用 send/任意 IPC。sandbox: true 下必须是 CommonJS（.cts →
 * .cjs）。所有载荷只做类型无关的透传，业务判断在 main。
 * @module @see-sol-lab/deepseekgui/terminal/preload
 */

import { contextBridge, ipcRenderer } from 'electron'

// main 经 additionalArguments 传入的 locale（P7-H：退出消息文案选语言）。
const localeArg = process.argv.find(arg => arg.startsWith('--deepseekgui-locale='))
const locale = localeArg?.slice('--deepseekgui-locale='.length) === 'zh' ? 'zh' : 'en'
// 终端宿主 label（URI 编码传入；启动期提示行显示真实 shell 名）。
const shellArg = process.argv.find(arg => arg.startsWith('--deepseekgui-shell='))
const shellLabel = shellArg === undefined ? '' : decodeURIComponent(shellArg.slice('--deepseekgui-shell='.length))

contextBridge.exposeInMainWorld('deepseekGUITerminal', {
  /** 界面语言（zh / en），renderer 的静态文案据此选择。 */
  locale,
  /** 终端宿主 label（如 PowerShell 7 / bash），启动期提示行用。 */
  shellLabel,
  /** 向 pty 发送用户输入（原样透传，main 只接受 string）。 */
  send: (data: string): Promise<void> => ipcRenderer.invoke('deepseekgui-terminal:send', data),
  /** 上报 xterm 的真实尺寸（P8-D47）：main 组帧转给 host 调 pty.resize。 */
  resize: (cols: number, rows: number): void => { ipcRenderer.send('deepseekgui-terminal:resize', cols, rows) },
  /** 终端调试取证（P8-D36）：单向、只收短字符串，落 userData 下的日志文件。 */
  /** 订阅 pty 输出（已脱敏的文本）。终端窗口只注册一次，监听器随窗口销毁。 */
  onData: (listener: (text: string) => void): void => {
    ipcRenderer.on('deepseekgui-terminal:data', (_event, text: unknown) => {
      if (typeof text === 'string') listener(text)
    })
  },
  /** 订阅终端进程退出（exitCode 或 null）。 */
  onExit: (listener: (exitCode: number | null) => void): void => {
    ipcRenderer.on('deepseekgui-terminal:exit', (_event, code: unknown) => {
      listener(typeof code === 'number' ? code : null)
    })
  },
  /** 订阅 host 错误（已脱敏消息）。 */
  onError: (listener: (message: string) => void): void => {
    ipcRenderer.on('deepseekgui-terminal:error', (_event, message: unknown) => {
      listener(typeof message === 'string' ? message : String(message))
    })
  },
})
