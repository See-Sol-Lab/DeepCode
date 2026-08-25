/**
 * P5 parity foundation：官方 Web 功能等价的验收地基，直接驱动打包后的
 * `dist/desktop/win-unpacked/DeepCode.exe`（playwright-core 的 Electron
 * 驱动，不依赖外装浏览器）。Electron userData 经 Chromium 标准开关
 * --user-data-dir 隔离进测试临时根（Windows 上 userData 走 Known Folder
 * API，不跟随 APPDATA 环境变量）；APPDATA/LOCALAPPDATA 钉扎与凭据形态
 * 环境变量剔除保留为纵深防御，不调用真实模型。完整矩阵与
 * 各项状态见 OFFICIAL_WEB_PARITY.md；尚未实现的矩阵项以 it.todo 占位——
 * 打包产物存在不等于功能通过。打包 exe 缺失时门禁测试明确失败（不假绿）。
 * @module @see-sol-lab/deepcode/tests-e2e/official-web-parity
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron, type ElectronApplication } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parityEnv } from './parity-env.ts'
import { EXE, packagedExists } from './fixtures.ts'
import {
  portConnectable as portOpen,
  COMP_URL_PREFIX,
  evalInView,
  shutdownApp,
  waitForCompMount,
  waitForWindow,
} from './chrome-driver.ts'

const APP_URL = 'http://127.0.0.1:3080/'

describe('打包产物门禁', () => {
  it('dist/desktop/win-unpacked/DeepCode.exe 存在（成品验收入口不得假绿）', () => {
    expect(packagedExists, `缺少 ${EXE}；先运行 \`pnpm run build:desktop-dist\` 再执行 parity 验收`).toBe(true)
  })
})

describe.runIf(packagedExists)('官方 Web 等价：打包 Electron 启动与生命周期', () => {
  let tempRoot: string
  let env: Record<string, string>
  let app: ElectronApplication | undefined

  beforeAll(async () => {
    // APPDATA（Electron userData、日志、单实例锁）、LOCALAPPDATA 与
    // DSH_HOME 全部落在同一个测试临时根内，绝不写真实用户目录。
    tempRoot = mkdtempSync(join(tmpdir(), 'dsh-parity-'))
    env = parityEnv(tempRoot)
    // userData 必须经 --user-data-dir 显式隔离：Windows 上 Electron 不理
    // env.APPDATA，缺了这个开关就写真实用户目录。
    app = await _electron.launch({
      executablePath: EXE,
      env,
      args: [`--user-data-dir=${join(tempRoot, 'userdata')}`],
      timeout: 120_000,
    })
    await waitForWindow(app)
  })

  afterAll(async () => {
    if (app !== undefined) await shutdownApp(app)
    // 临时根内是本次运行的全部痕迹（userData、日志、DSH_HOME），清理干净。
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  })

  it('打包 exe 打开官方 Web UI 并完成前端挂载', async () => {
    // 官方前端在 Compatibility View（独立 WebContentsView）里挂在 #root 下；
    // 子元素出现说明 UI 真正渲染了，而不只是拿到了 index.html。
    await waitForCompMount(app!)
    const url = await app!.evaluate(({ webContents }, prefix) => {
      const target = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(prefix))
      return target?.getURL() ?? ''
    }, COMP_URL_PREFIX)
    // P8-D39 之后这个 URL 带控制桥参数（?deepcode-control=<port>.<token>）：
    // 那是 settings-plugin 连回桌面控制面的凭据，不是另一个地址——外部浏览器
    // 打开 3080 时没有它，也因此看不到 DeepCode 分区。比对去掉 query 之后的
    // 地址：既证明打开的确实是官方 Web UI，又不把桥参数当成差异。
    expect(url.split('?')[0]).toBe(APP_URL)
  })

  it('窗口标题固定为 DeepCode，Compatibility View 的 title 来自品牌构建', async () => {
    const windowTitle = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle())
    expect(windowTitle).toBe('DeepCode')
    // 品牌串在 build:lib:client（tsdown）阶段内联进前端产物，由
    // build-web-branded 连同 client lib 一起带环境构建——所以**打包态**的
    // document.title 是 DeepCode，裸跑才会退回上游的 DSH Local Build。
    // 改的是我们自己的发行构建，不是上游文件。
    expect(await evalInView<string>(app!, COMP_URL_PREFIX, 'document.title')).toBe('DeepCode')
  })

  it('第二实例立即退出，首实例窗口保持唯一并取得焦点', async () => {
    // 同一 userData（同一 --user-data-dir）——单实例锁的作用域就在
    // userData 下，第二实例必须带同一开关才竞争同一把锁。
    const second = spawn(EXE, [`--user-data-dir=${join(tempRoot, 'userdata')}`], { env, stdio: 'ignore' })
    const exit = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('第二实例 20s 内未退出')) }, 20_000)
      second.once('exit', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })
    expect(exit).toBe(0)
    // BrowserWindow 计数（playwright 的 windows() 可能把 WebContentsView 也算作页面）。
    expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    // second-instance 处理器调用 restore()+focus()：断言窗口未最小化且
    // 持有系统焦点。
    await expect.poll(
      () => app!.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        return win !== undefined && !win.isMinimized() && win.isFocused()
      }),
      { timeout: 10_000 },
    ).toBe(true)
  })

  it('关闭应用后端口释放、无残留进程', async () => {
    const closing = app!
    app = undefined
    await closing.close()
    await expect.poll(() => portOpen(3080), { timeout: 15_000 }).toBe(false)
    const tasklist = spawnSync('tasklist', ['/FI', 'IMAGENAME eq DeepCode.exe'], { encoding: 'utf8' })
    expect(tasklist.stdout).not.toContain('DeepCode.exe')
  })
})

// —— 功能矩阵占位：每一项在实现真实驱动前保持 todo，不以“包存在”充当通过。 ——
describe('官方 Web 等价：功能矩阵（待实现驱动）', () => {
  it.todo('首次引导：Models/API key 配置页可达并可保存（凭据仅落 DSH_HOME）')
  it.todo('模型选择：官方 Models 页列出可选模型并持久化选择')
  it.todo('工作区选择与管理（官方目录浏览 UI）')
  it.todo('新建会话、恢复历史会话、搜索会话')
  it.todo('流式对话（replay/mock，无真实模型）与停止')
  it.todo('重试、steer、queue、branch')
  it.todo('Markdown 渲染与代码块复制')
  it.todo('外链在系统默认浏览器打开（窗口内不加载远程页面）')
  it.todo('图片显示与附件（上传/拖拽/粘贴）')
  it.todo('文件下载行为（保存位置与提示）')
  it.todo('剪贴板复制/粘贴')
  it.todo('pwsh 工具执行与输出渲染')
  it.todo('文件读写、搜索、替换工具')
  it.todo('权限确认（approval/ask-user 流程）')
  it.todo('standard/code/cordis/minimal 四种 preset 均可创建会话')
  it.todo('plan 模式、goal、todo 工具')
  it.todo('skill 加载与调用')
  it.todo('subagent 委派')
  it.todo('background jobs 与 workflow')
  it.todo('deliverables 与 trajectory 面板')
  it.todo('feedback 与 session export')
  it.todo('plugin settings 与 plugin inventory 页面')
  it.todo('关闭重开后同一会话可恢复（sessions 落在 DSH_HOME）')
  it.todo('会话/工具运行中关窗：终止语义与重开后恢复（见 OFFICIAL_WEB_PARITY.md 决策）')
  it.todo('异常启动路径：端口被占、服务崩溃的 GUI 错误与诊断日志')
})
