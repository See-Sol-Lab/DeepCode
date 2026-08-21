/**
 * DSH Terminal 的窄 preload：只暴露 deepCodeTerminal 四个具名 API，
 * 不暴露通用 send/任意 IPC。sandbox: true 下必须是 CommonJS（.cts →
 * .cjs）。所有载荷只做类型无关的透传，业务判断在 main。
 * @module @see-sol-lab/deepcode/terminal/preload
 */

import { contextBridge, ipcRenderer } from 'electron'

// main 经 additionalArguments 传入的 locale（P7-H：退出消息文案选语言）。
const localeArg = process.argv.find(arg => arg.startsWith('--deepcode-locale='))
const locale = localeArg?.slice('--deepcode-locale='.length) === 'zh' ? 'zh' : 'en'

contextBridge.exposeInMainWorld('deepCodeTerminal', {
  /** 界面语言（zh / en），renderer 的静态文案据此选择。 */
  locale,
  /** 向 pty 发送用户输入（原样透传，main 只接受 string）。 */
  send: (data: string): Promise<void> => ipcRenderer.invoke('deepcode-terminal:send', data),
  /** 订阅 pty 输出（已脱敏的文本）。终端窗口只注册一次，监听器随窗口销毁。 */
  onData: (listener: (text: string) => void): void => {
    ipcRenderer.on('deepcode-terminal:data', (_event, text: unknown) => {
      if (typeof text === 'string') listener(text)
    })
  },
  /** 订阅终端进程退出（exitCode 或 null）。 */
  onExit: (listener: (exitCode: number | null) => void): void => {
    ipcRenderer.on('deepcode-terminal:exit', (_event, code: unknown) => {
      listener(typeof code === 'number' ? code : null)
    })
  },
  /** 订阅 host 错误（已脱敏消息）。 */
  onError: (listener: (message: string) => void): void => {
    ipcRenderer.on('deepcode-terminal:error', (_event, message: unknown) => {
      listener(typeof message === 'string' ? message : String(message))
    })
  },
})
