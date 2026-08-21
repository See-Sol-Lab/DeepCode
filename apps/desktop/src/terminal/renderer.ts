/**
 * DSH Terminal renderer：xterm（vendored）渲染 pty 字节流。只消费
 * preload 暴露的 deepCodeTerminal API；不持有任何业务状态。
 * @module @see-sol-lab/deepcode/terminal/renderer
 */

import { Terminal } from '../../src/terminal/vendor/xterm.mjs'
import { FitAddon } from '../../src/terminal/vendor/addon-fit.mjs'

interface DeepCodeTerminalApi {
  /** 界面语言（zh/en，main 经 additionalArguments 传入）。 */
  locale: 'zh' | 'en'
  send(data: string): Promise<void>
  onData(listener: (text: string) => void): void
  onExit(listener: (exitCode: number | null) => void): void
  onError(listener: (message: string) => void): void
}

const api = (window as unknown as { deepCodeTerminal: DeepCodeTerminalApi }).deepCodeTerminal

const container = document.getElementById('terminal') as HTMLElement
const term = new Terminal({
  cursorBlink: true,
  fontSize: 13,
  fontFamily: '"Cascadia Mono", "Consolas", monospace',
  theme: { background: '#0c0c0c', foreground: '#e8e8ea' },
})
const fit = new FitAddon()
term.loadAddon(fit)
term.open(container)
fit.fit()
term.focus()
window.addEventListener('resize', () => { fit.fit() })
term.onData((data) => { void api.send(data) })
api.onData((text) => { term.write(text) })
api.onError((message) => { term.write(`\r\n[deepcode] ${message}\r\n`) })
api.onExit((exitCode) => {
  // 退出消息按界面语言选择（P7-H：英文系统不再看到中文方块字）。
  const message = api.locale === 'zh'
    ? `终端已退出（exitCode=${String(exitCode)}）。可关闭此窗口。`
    : `Terminal exited (exitCode=${String(exitCode)}). You can close this window.`
  term.write(`\r\n[deepcode] ${message}\r\n`)
})
