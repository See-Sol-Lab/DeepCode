/**
 * DSH Terminal renderer：xterm（vendored）渲染 pty 字节流。只消费
 * preload 暴露的 deepseekGUITerminal API；不持有任何业务状态。
 * @module @see-sol-lab/deepseekgui/terminal/renderer
 */

import { Terminal } from '../../src/terminal/vendor/xterm.mjs'
import { FitAddon } from '../../src/terminal/vendor/addon-fit.mjs'

interface DeepSeekGUITerminalApi {
  /** 界面语言（zh/en，main 经 additionalArguments 传入）。 */
  locale: 'zh' | 'en'
  /** 终端宿主 label（如 PowerShell 7 / bash），启动期提示行用。 */
  shellLabel: string
  send(data: string): Promise<void>
  resize(cols: number, rows: number): void
  onData(listener: (text: string) => void): void
  onExit(listener: (exitCode: number | null) => void): void
  onError(listener: (message: string) => void): void
}

const api = (window as unknown as { deepseekGUITerminal: DeepSeekGUITerminalApi }).deepseekGUITerminal

const container = document.getElementById('terminal') as HTMLElement
// 终端永远深色（P8-D28 住户定，主题跟随实测被否）：黑底白字是终端这个
// 物种的皮肤，与应用主题无关。背景与 chrome 深色 --surface 同值。
const term = new Terminal({
  cursorBlink: true,
  fontSize: 13,
  fontFamily: '"Cascadia Mono", "Consolas", monospace',
  theme: { background: '#0a0a0a', foreground: '#e8e8ea' },
})
const fit = new FitAddon()
term.loadAddon(fit)
term.open(container)
fit.fit()
term.focus()
// P8-D47：把 fit 出的真实尺寸告诉 pty（host 启动值是 100×30 占位）。
// 两边列数不一致时 PSReadLine 语法高亮重绘按 pty 列数定位，输入行在更宽
// 的 xterm 上画成多重叠影（字节没错，纯显示错位——住户实测回车执行正常）。
api.resize(term.cols, term.rows)
// 启动期提示（P8-D36）：shell 的提示符出现前窗口是全黑的，用户会当它死了。
// 暗色一行说明（D29：按界面语言），shell 输出到来后自然被顶上去。
const shellName = api.shellLabel === '' ? 'shell' : api.shellLabel
const startingHint = api.locale === 'zh'
  ? `正在启动 ${shellName}，出现提示符后即可输入…`
  : `Starting ${shellName} — you can type once the prompt appears…`
term.write(`\x1b[2m${startingHint}\x1b[0m\r\n`)
// 窗口重获焦点时把键盘还给终端（点了别处再回来，光标要立刻能打字）。
window.addEventListener('focus', () => { term.focus() })
window.addEventListener('resize', () => {
  fit.fit()
  // 窗口改尺寸后 pty 跟着走，否则回到 D47 的叠影。fit 是同步的，resize
  // 事件本身已被系统节流，这里不再加 debounce。
  api.resize(term.cols, term.rows)
})
term.onData((data) => { void api.send(data) })
api.onData((text) => { term.write(text) })
api.onError((message) => { term.write(`\r\n[deepseekgui] ${message}\r\n`) })
api.onExit((exitCode) => {
  // 退出消息按界面语言选择（P7-H：英文系统不再看到中文方块字）。
  const message = api.locale === 'zh'
    ? `终端已退出（exitCode=${String(exitCode)}）。可关闭此窗口。`
    : `Terminal exited (exitCode=${String(exitCode)}). You can close this window.`
  term.write(`\r\n[deepseekgui] ${message}\r\n`)
})
