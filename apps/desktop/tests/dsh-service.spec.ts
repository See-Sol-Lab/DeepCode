/**
 * dsh-service 纯逻辑测试：命令组装、仓库根解析、端口探测、就绪等待、进程停止。
 * 不涉及 Electron，可在普通 Node 环境下运行。
 * @module @see-sol-lab/deepcode/tests/dsh-service
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  PROBE_FAST_INTERVAL_MS,
  ProcessStopError,
  PROBE_TIMEOUT_MS,
  READY_TIMEOUT_MS,
  PROBE_INTERVAL_MS,
  MANAGED_HOME_BLOCKED_ENV,
  childStdio,
  classifyLinkOpen,
  createServiceLogWriter,
  BROWSER_PLUGIN_PACKAGE,
  ensurePluginResolvable,
  inheritedEnv,
  portInUse,
  profileBundlesInclude,
  repoRoot,
  resolveDshLaunch,
  resolveThemePatchFile,
  resolveThemePluginDir,
  THEME_PATCH_FILENAME,
  stopProcess,
  waitForServer,
} from '../src/dsh-service.ts'

const servers: Server[] = []

async function listen(server: Server): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  return (server.address() as AddressInfo).port
}

async function closeAll(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() =>{  resolve() }))))
}

afterEach(async () => {
  await closeAll()
})

describe('resolveDshLaunch', () => {
  it('开发态组装 tsx 源码启动参数（profile 显式传入，host/port 固定；插件不存在时不带 overlay）', () => {
    const { command, args, cwd, env } = resolveDshLaunch({
      packaged: false,
      root: 'R:\\repo',
      nodeExecutable: 'C:\\node.exe',
      profile: 'web',
      dshHome: 'R:\\data\\dsh',
    })
    expect(command).toBe('C:\\node.exe')
    expect(args).toEqual([
      '--import', 'tsx/esm',
      'apps/cli/src/bin.ts',
      '--profile', 'web',
      '--host', '127.0.0.1',
      '--port', '3080',
      '--no-open',
    ])
    expect(cwd).toBe('R:\\repo')
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('开发态尊重自定义 host/port', () => {
    const { args } = resolveDshLaunch({
      packaged: false,
      root: '/r',
      profile: 'web',
      dshHome: '/data/dsh',
      host: '0.0.0.0',
      port: 9090,
      nodeExecutable: 'node',
    })
    expect(args).toContain('0.0.0.0')
    expect(args).toContain('9090')
  })

  it('profile 显式透传，不校验取值（名称合法性由 launcher state schema 把关）', () => {
    const { args } = resolveDshLaunch({
      packaged: false,
      root: '/r',
      profile: 'headless',
      dshHome: '/data/dsh',
      nodeExecutable: 'node',
    })
    expect(args[args.indexOf('--profile') + 1]).toBe('headless')
  })

  it('开发态未注入 npm_node_execpath 时回退到 PATH 中的 node', () => {
    const saved = process.env.npm_node_execpath
    delete process.env.npm_node_execpath
    try {
      expect(resolveDshLaunch({ packaged: false, root: '/r', profile: 'web', dshHome: '/data/dsh' }).command).toBe('node')
    } finally {
      if (saved !== undefined) process.env.npm_node_execpath = saved
    }
  })

  it('开发态默认使用 npm_node_execpath（pnpm/npm 注入的 Node 路径）', () => {
    const saved = process.env.npm_node_execpath
    process.env.npm_node_execpath = 'C:\\injected\\node.exe'
    try {
      expect(resolveDshLaunch({ packaged: false, root: '/r', profile: 'web', dshHome: '/data/dsh' }).command).toBe('C:\\injected\\node.exe')
    } finally {
      if (saved !== undefined) process.env.npm_node_execpath = saved
    }
  })

  it('打包态用自身可执行文件充当 Node，运行发行目录内的 bin.js', () => {
    const { command, args, cwd, env } = resolveDshLaunch({
      packaged: true,
      packagedExecutable: 'C:\\dist\\DeepCode.exe',
      resourcesPath: 'C:\\dist\\resources',
      packagedCwd: 'C:\\Users\\alice',
      profile: 'web',
      dshHome: 'C:\\Users\\alice\\AppData\\Roaming\\DeepCode\\dsh',
      port: DEFAULT_PORT,
    })
    expect(command).toBe('C:\\dist\\DeepCode.exe')
    expect(args).toEqual([
      '--expose-internals',
      'C:\\dist\\resources\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
      '--profile', 'web',
      '--host', '127.0.0.1',
      '--port', '3080',
      '--no-open',
    ])
    expect(cwd).toBe('C:\\Users\\alice')
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('打包态注入 selection 决定的 DSH_HOME', () => {
    const { env } = resolveDshLaunch({
      packaged: true,
      profile: 'web',
      dshHome: 'C:\\Users\\alice\\AppData\\Roaming\\DeepCode\\dsh',
      resourcesPath: 'C:\\dist\\resources',
    })
    expect(env.DSH_HOME).toBe('C:\\Users\\alice\\AppData\\Roaming\\DeepCode\\dsh')
  })

  it('DSH_HOME 显式覆盖环境（dev 与 packaged 一致）', () => {
    const saved = process.env.DSH_HOME
    process.env.DSH_HOME = 'C:\\custom\\dsh-home'
    try {
      expect(resolveDshLaunch({ packaged: true, profile: 'web', dshHome: 'C:\\selected', resourcesPath: 'C:\\dist\\resources' }).env.DSH_HOME).toBe('C:\\selected')
      expect(resolveDshLaunch({ packaged: false, profile: 'web', dshHome: 'C:\\selected', root: '/r' }).env.DSH_HOME).toBe('C:\\selected')
    } finally {
      if (saved !== undefined) process.env.DSH_HOME = saved
      else delete process.env.DSH_HOME
    }
  })

  it('开发态同样注入 selection 决定的 DSH_HOME', () => {
    const { env } = resolveDshLaunch({ packaged: false, root: '/r', profile: 'web', dshHome: '/data/dsh' })
    expect(env.DSH_HOME).toBe('/data/dsh')
  })
})

describe('childStdio', () => {
  it('开发态继承宿主控制台', () => {
    expect(childStdio(false, false)).toBe('inherit')
    expect(childStdio(false, true)).toBe('inherit')
  })

  it('打包态 smoke 保留输出能力', () => {
    expect(childStdio(true, true)).toBe('inherit')
  })

  it('正常打包 GUI 将子进程输出 pipe 进诊断日志', () => {
    expect(childStdio(true, false)).toBe('pipe')
  })
})

describe('classifyLinkOpen', () => {
  it('本机 DSH 页面在窗口内导航', () => {
    expect(classifyLinkOpen(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/`)).toBe('app')
    expect(classifyLinkOpen(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/sessions/abc`)).toBe('app')
  })

  it('http/https 外链交系统浏览器', () => {
    expect(classifyLinkOpen('https://github.com/deepseek-ai/deepseek-harness')).toBe('external')
    expect(classifyLinkOpen('http://example.com/doc')).toBe('external')
    // 同机不同端口不是本应用页面。
    expect(classifyLinkOpen(`http://${DEFAULT_HOST}:9999/`)).toBe('external')
  })

  it('其他协议与畸形 URL 一律拒绝', () => {
    expect(classifyLinkOpen('file:///C:/Windows/system.ini')).toBe('deny')
    expect(classifyLinkOpen('javascript:alert(1)')).toBe('deny')
    expect(classifyLinkOpen('not a url')).toBe('deny')
  })
})

describe('createServiceLogWriter', () => {
  let temp: string | undefined

  afterEach(() => {
    if (temp !== undefined) rmSync(temp, { recursive: true, force: true })
    temp = undefined
  })

  it('落盘前脱敏 API key 形态的片段', () => {
    temp = mkdtempSync(join(tmpdir(), 'dsh-log-'))
    const path = join(temp, 'dsh-service.log')
    const log = createServiceLogWriter(path)
    log.write(`Authorization: Bearer sk-${'a'.repeat(30)}\n`)
    log.close()
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('sk-<redacted>')
    expect(content).not.toContain('a'.repeat(30))
  })

  it('超过大小上限后停止写入并留截断标记', () => {
    temp = mkdtempSync(join(tmpdir(), 'dsh-log-'))
    const path = join(temp, 'dsh-service.log')
    const log = createServiceLogWriter(path, 100)
    log.write('A'.repeat(90))
    log.write('B'.repeat(90))
    log.write('C'.repeat(90))
    log.close()
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('log size limit reached')
    expect(content).not.toContain('B')
    expect(content).not.toContain('C')
  })

  it('连续六次启动：历史逐级 shift、序号连续无空洞、最老先删、证据不丢', () => {
    temp = mkdtempSync(join(tmpdir(), 'dsh-log-'))
    const path = join(temp, 'dsh-service.log')
    const runs = ['run1', 'run2', 'run3', 'run4', 'run5', 'run6']
    for (const run of runs) {
      const log = createServiceLogWriter(path)
      log.write(`${run}\n`)
      log.close()
    }
    // 第六次启动后：current = run6；.1=run5、.2=run4、.3=run3、.4=run2；
    // run1（最老）已按份数上限删除。序号必须连续、内容必须对应。
    expect(readFileSync(path, 'utf8')).toContain('run6')
    expect(readFileSync(`${path}.1`, 'utf8')).toContain('run5')
    expect(readFileSync(`${path}.2`, 'utf8')).toContain('run4')
    expect(readFileSync(`${path}.3`, 'utf8')).toContain('run3')
    expect(readFileSync(`${path}.4`, 'utf8')).toContain('run2')
    expect(existsSync(`${path}.5`)).toBe(false)
    const names = readdirSync(temp).filter(name => /^dsh-service\.log(\.\d+)?$/.test(name)).sort()
    const indices = names
      .map(name => /\.(\d+)$/.exec(name))
      .map(match => (match === null ? 0 : Number(match[1])))
      .sort((a, b) => a - b)
    expect(indices).toEqual(indices.map((_value, position) => position))
    expect(names).toHaveLength(5)
  })

  it('跨 stream chunk 拆开的密钥同样被脱敏', () => {
    temp = mkdtempSync(join(tmpdir(), 'dsh-log-'))
    const path = join(temp, 'dsh-service.log')
    const log = createServiceLogWriter(path)
    log.write('Authorization: Bearer sk-abc')
    log.write(`${'d'.repeat(30)} done\n`)
    log.close()
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('sk-<redacted>')
    expect(content).not.toContain('d'.repeat(30))
    // 尾部扣下的可疑前缀在 close 时补写，正常文本不丢失。
    expect(content).toContain('done')
  })

  it('多字节 UTF-8 字符被 chunk 边界拆开也不破坏，且其间的密钥照常脱敏', () => {
    temp = mkdtempSync(join(tmpdir(), 'dsh-log-'))
    const path = join(temp, 'dsh-service.log')
    const log = createServiceLogWriter(path)
    const text = `汉字日志 sk-${'f'.repeat(20)} 结束\n`
    const bytes = Buffer.from(text, 'utf8')
    // 逐字节写入：每个多字节字符与密钥都必然被边界拆开。
    for (let i = 0; i < bytes.length; i += 1) {
      log.write(bytes.subarray(i, i + 1))
    }
    log.close()
    const content = readFileSync(path, 'utf8')
    expect(content).toBe('汉字日志 sk-<redacted> 结束\n')
    expect(content).not.toContain('�')
  })

  it('大小上限按 UTF-8 字节计算，截断标记不突破上限', () => {
    temp = mkdtempSync(join(tmpdir(), 'dsh-log-'))
    const path = join(temp, 'dsh-service.log')
    const max = 200
    const log = createServiceLogWriter(path, max)
    // 每个中文字符 3 字节：40 字符 = 120 字节，两次即超预算。
    log.write('汉'.repeat(40))
    log.write('字'.repeat(40))
    log.write('更多输出')
    log.close()
    const stat = statSync(path)
    expect(stat.size).toBeLessThanOrEqual(max)
    expect(readFileSync(path, 'utf8')).toContain('log size limit reached')
  })

  it('日志位置不可写时静默失效，不向主进程抛异常', () => {
    temp = mkdtempSync(join(tmpdir(), 'dsh-log-'))
    // 目标路径是一个目录：openSync 必然失败。
    const path = join(temp, 'as-directory')
    mkdirSync(path)
    const log = createServiceLogWriter(path)
    expect(() => {
      log.write('anything')
      log.close()
    }).not.toThrow()
  })
})

describe('repoRoot', () => {
  it('从 src 与 lib 两种锚点都解析到仓库根', () => {
    const root = repoRoot()
    expect(existsSync(join(root, 'package.json'))).toBe(true)
    expect(existsSync(join(root, 'apps', 'cli', 'package.json'))).toBe(true)
  })
})

describe('portInUse', () => {
  it('被占用端口返回 true', async () => {
    const port = await listen(createServer())
    expect(await portInUse(DEFAULT_HOST, port)).toBe(true)
  })

  it('空闲端口返回 false', async () => {
    const port = await listen(createServer())
    await closeAll()
    expect(await portInUse(DEFAULT_HOST, port)).toBe(false)
  })
})

describe('waitForServer', () => {
  it('服务就绪后 resolve', async () => {
    const port = await listen(createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('ok')
    }))
    await waitForServer(DEFAULT_HOST, port, 3_000)
  })

  it('超时后 reject', async () => {
    await expect(waitForServer(DEFAULT_HOST, 1, 600)).rejects.toThrow(/未就绪/)
  })

  it('前段用快间隔探测：服务在稳态间隔之内就绪时不必多等一整个周期', async () => {
    // 服务在 ~40ms 后起来。稳态间隔（250ms）下第一次探测失败后要固定等满
    // 一个周期才会再探，最快也要 250ms 才发现；前段快间隔（50ms）应当在
    // 就绪后一个快周期内发现，约 50ms。断言只区分"一个稳态周期"与"一个快
    // 周期"这两个量级，不对具体调度时间较真。
    //
    // 启动延迟刻意压得比快间隔还短：原先设成 120ms 时，正常路径要 ~150ms，
    // 距离 250ms 的断言只剩 80ms 余量，全量并发跑起来光调度抖动就能吃掉它
    // （2026-08-25 实测偶发变红，单独跑必过）。40ms 让正常路径落在 ~50ms，
    // 余量翻到 200ms，而要区分的那两个量级一点没变。
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('ok')
    })
    const port = await new Promise<number>((resolve) => {
      const probe = createServer()
      probe.listen(0, '127.0.0.1', () => {
        const assigned = (probe.address() as AddressInfo).port
        probe.close(() => { resolve(assigned) })
      })
    })
    const startedAt = Date.now()
    const ready = waitForServer(DEFAULT_HOST, port, 3_000)
    setTimeout(() => { servers.push(server); server.listen(port, '127.0.0.1') }, 40)
    await ready
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeLessThan(PROBE_INTERVAL_MS)
    expect(PROBE_FAST_INTERVAL_MS).toBeLessThan(PROBE_INTERVAL_MS)
  })
})

describe('stopProcess', () => {
  it('终止运行中的子进程并等待其退出', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    await stopProcess(child, 2_000)
    // Windows 上 kill() 为信号退出（signalCode 非空），exitCode 恒为 null。
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  it('已退出的进程直接 resolve', async () => {
    const child = spawn(process.execPath, ['-e', ''])
    await new Promise<void>((resolve) => {
      child.once('exit', () =>{  resolve() })
    })
    await expect(stopProcess(child)).resolves.toBeUndefined()
  })

  it.runIf(process.platform === 'win32')('taskkill 非零退出且目标仍在运行时回退为直接终止', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    // 模拟 taskkill 失败（权限不足等）：立刻以退出码 1 结束、不杀任何进程。
    const fakeTreeKill = (): ReturnType<typeof spawn> => spawn(process.execPath, ['-e', 'process.exit(1)'])
    await stopProcess(child, 10_000, fakeTreeKill)
    // 回退的 child.kill() 在宽限时间内终止了子进程（不是等到 SIGKILL 定时器）。
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  it.runIf(process.platform === 'win32')('Windows 上终止整棵进程树（孙进程不残留）', async () => {
    // 子进程再 spawn 一个孙进程并报告其 pid；直接 kill() 只终止子进程，
    // taskkill /T 才能连孙进程一起终止。
    const script = "const{spawn}=require('node:child_process');"
      + "const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);"
      + "console.log('GPID:'+g.pid);setInterval(()=>{},1000)"
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })
    const grandchildPid = await new Promise<number>((resolve, reject) => {
      let buffer = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const match = /GPID:(\d+)/.exec(buffer)
        if (match?.[1] !== undefined) resolve(Number(match[1]))
      })
      child.once('exit', () => { reject(new Error('child exited before reporting the grandchild pid')) })
    })
    await stopProcess(child, 5_000)
    // taskkill 对整棵树的终止是异步完成的；轮询等待孙进程消失。
    await expect.poll(() => {
      try {
        process.kill(grandchildPid, 0)
        return true
      } catch {
        // ESRCH/EPERM-on-dead: the grandchild is gone.
        return false
      }
    }, { timeout: 5_000 }).toBe(false)
  })
})

describe('DEFAULT_PORT', () => {
  it('与官方 Web UI 的默认端口一致', () => {
    expect(DEFAULT_PORT).toBe(3080)
  })
})

describe('内置浏览器 overlay 与 profile bundles 互斥', () => {
  /**
   * 浏览器插件是唯一有两条进入 composition 的路的自带插件：随包内置走
   * launcher 的 `--patch`，用户手动安装走 profile 的 bundles 层（插件的
   * package.json 声明了 `dsh.bundle.patch`）。两条同时生效会插入同一个
   * loader id，官方 loader 抛 `duplicate loader entry id: deepcode-browser`
   * 硬退出——用户看到的只是"DSH 服务启动失败"，没有任何线索指向这里。
   * 住户 2026-08-24 实机撞上：她在 B3-10 用插件管理装过一次。
   */
  /** 开发态仓库骨架：browser 插件目录 + 它自带的 overlay。 */
  function stageBrowserRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'deepcode-browser-root-'))
    const dir = join(root, 'apps', 'desktop', 'browser-plugin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n    - id: deepcode-browser\n')
    return root
  }

  /** profile 清单：bundles 里带不带 browser 包。 */
  function stageProfile(home: string, profile: string, bundles: string[]): void {
    const dir = join(home, 'profiles', profile)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
      name: `dsh-profile-${profile}`,
      private: true,
      dsh: { profile: { bundles } },
    }, undefined, 2)}\n`)
  }

  /** args 里所有 --patch 的值。 */
  function patchValues(args: string[]): string[] {
    return args.flatMap((arg, index) => arg === '--patch' ? [args[index + 1] ?? ''] : [])
  }

  it('profile 没列这个包时照常带 overlay（全新安装：内置那条路）', () => {
    const root = stageBrowserRepo()
    const home = mkdtempSync(join(tmpdir(), 'deepcode-browser-home-'))
    stageProfile(home, 'web', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])

    const { args } = resolveDshLaunch({
      packaged: false, root, nodeExecutable: 'node', profile: 'web', dshHome: home,
    })
    expect(patchValues(args).some(value => value.endsWith('cordis.patch.yml'))).toBe(true)

    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('profile 已把这个包列进 bundles 时不带 overlay：重复 id 会让 Harness 起不来', () => {
    const root = stageBrowserRepo()
    const home = mkdtempSync(join(tmpdir(), 'deepcode-browser-home-'))
    stageProfile(home, 'web', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', BROWSER_PLUGIN_PACKAGE])

    const { args } = resolveDshLaunch({
      packaged: false, root, nodeExecutable: 'node', profile: 'web', dshHome: home,
    })
    expect(patchValues(args).some(value => value.endsWith('cordis.patch.yml'))).toBe(false)

    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('清单缺失或读不动时按"没列"处理：与全新安装同形，不因读文件失败丢掉浏览器', () => {
    const home = mkdtempSync(join(tmpdir(), 'deepcode-browser-home-'))
    expect(profileBundlesInclude(home, 'web', BROWSER_PLUGIN_PACKAGE)).toBe(false)
    const dir = join(home, 'profiles', 'web')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{ not json')
    expect(profileBundlesInclude(home, 'web', BROWSER_PLUGIN_PACKAGE)).toBe(false)
    writeFileSync(join(dir, 'package.json'), '{"dsh":{"profile":{}}}')
    expect(profileBundlesInclude(home, 'web', BROWSER_PLUGIN_PACKAGE)).toBe(false)
    rmSync(home, { recursive: true, force: true })
  })
})

describe('皮肤 overlay（--patch）与模块 fallback', () => {
  /**
   * 皮肤走 launcher 层而不是 `dsh plugin add`：合成顺序里 --patch 落在最后，
   * 只影响 DeepCode 启动的这一轮，用户 profile 的清单一个字节都不改。
   */
  it('打包态指向 DSH 运行时目录内的 overlay（那个 Node 进程读不到 asar）', () => {
    const file = resolveThemePatchFile({ packaged: true, resourcesPath: 'C:\\app\\resources' })
    expect(file).toBe(join('C:\\app\\resources', 'dsh', THEME_PATCH_FILENAME))
  })

  it('开发态指向仓库内的 overlay', () => {
    const file = resolveThemePatchFile({ packaged: false, root: 'R:\\repo' })
    expect(file).toBe(join('R:\\repo', 'apps', 'desktop', 'theme-plugin', THEME_PATCH_FILENAME))
  })

  it('缺少定位信息时不产生 overlay：宁可没皮肤，也不能让 Harness 起不来', () => {
    expect(resolveThemePatchFile({ packaged: true })).toBeUndefined()
    expect(resolveThemePatchFile({ packaged: false })).toBeUndefined()
    expect(resolveThemePluginDir({ packaged: true })).toBeUndefined()
    expect(resolveThemePluginDir({ packaged: false })).toBeUndefined()
  })

  it('插件目录不存在时不带 overlay：加载不了的插件会让整个 Harness 起不来', () => {
    const { args } = resolveDshLaunch({
      packaged: false,
      root: join(tmpdir(), 'deepcode-no-such-repo'),
      nodeExecutable: 'node',
      profile: 'web',
      dshHome: join(tmpdir(), 'deepcode-no-such-home'),
    })
    expect(args).not.toContain('--patch')
    expect(args).toContain('--profile')
  })

  it('插件可解析时建立 fallback 链接，并把 overlay 排在 dsh 自己的选项区内', () => {
    // dsh 的用法是 `dsh [options] [command] [args...]`：自身选项之后的一切
    // 原样转交给 profile 的 app。--patch 排到 --host/--port 后面就会被当成
    // 给 web app 的参数转走，启动时 `unknown option '--patch'`（实机抓获）。
    const root = mkdtempSync(join(tmpdir(), 'deepcode-root-'))
    const home = mkdtempSync(join(tmpdir(), 'deepcode-home-'))
    const pluginDir = join(root, 'apps', 'desktop', 'theme-plugin')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, THEME_PATCH_FILENAME), '- insert: []\n')

    const { args } = resolveDshLaunch({
      packaged: false,
      root,
      nodeExecutable: 'node',
      profile: 'web',
      dshHome: home,
    })
    const patchAt = args.indexOf('--patch')
    expect(patchAt).toBeGreaterThan(args.indexOf('--profile'))
    expect(patchAt).toBeLessThan(args.indexOf('--host'))

    // 链接落在**安装级 fallback**里，不是任何 profile 的清单：
    // profile 目录本身必须仍然干净。
    const link = join(home, 'profiles', 'node_modules', '@see-sol-lab', 'deepcode-theme')
    expect(existsSync(link)).toBe(true)
    expect(realpathSync(link)).toBe(realpathSync(pluginDir))
    expect(existsSync(join(home, 'profiles', 'web'))).toBe(false)

    // 幂等：再来一次不报错、链接仍然正确。
    resolveDshLaunch({
      packaged: false, root, nodeExecutable: 'node', profile: 'web', dshHome: home,
    })
    expect(realpathSync(link)).toBe(realpathSync(pluginDir))

    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('链接指向已消失的旧安装路径时重建到新路径（卸载重装的必经之路）', () => {
    // P8-D22：`existsSync` 跟随链接，指向已删除目标的坏 junction 会被它报成
    // "不存在"，代码于是直奔 symlinkSync——而那条路径上正有坏链接占位，创建
    // 必然失败，插件从此永远解析不了：皮肤 overlay 不传、client 标记不置位、
    // Harness 每次启动都以 page-load 超时收场，错误文案还完全不指向这里。
    // 住户 2026-08-22 实机撞上：卸载 Program Files 版之后改用 win-unpacked。
    const root = mkdtempSync(join(tmpdir(), 'deepcode-root-'))
    const home = mkdtempSync(join(tmpdir(), 'deepcode-home-'))
    const gone = join(root, 'old-install', 'theme-plugin')
    mkdirSync(gone, { recursive: true })
    const link = join(home, 'profiles', 'node_modules', '@see-sol-lab', 'deepcode-theme')
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(gone, link, 'junction')
    // 模拟卸载：链接的目标整个消失，链接本身留在原地。
    rmSync(join(root, 'old-install'), { recursive: true, force: true })
    // 这一行就是 bug 的机理本身：链接明明占着位置，existsSync 却说"不存在"。
    expect(existsSync(link)).toBe(false)

    const pluginDir = join(root, 'apps', 'desktop', 'theme-plugin')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, THEME_PATCH_FILENAME), '- insert: []\n')

    const { args } = resolveDshLaunch({
      packaged: false, root, nodeExecutable: 'node', profile: 'web', dshHome: home,
    })
    // overlay 必须照常带上，链接必须重建到新路径。
    expect(args).toContain('--patch')
    expect(realpathSync(link)).toBe(realpathSync(pluginDir))

    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })
})

describe('inheritedEnv：Managed Home 不把宿主的模型密钥透传给 DSH（P8-D23）', () => {
  it('Managed Home 下拦掉 DEEPSEEK_API_KEY，其余变量原样保留', () => {
    // 官方凭据模型里「继承的环境优先」：宿主留着这个变量，官方设置里的密钥输入框
    // 就会被锁成只读，用户在 GUI 里永远换不了 key（住户 2026-08-22 实机撞上）。
    const env = inheritedEnv(true, { DEEPSEEK_API_KEY: 'sk-host', EXA_API_KEY: 'exa', PATH: 'p' })
    expect(env[MANAGED_HOME_BLOCKED_ENV]).toBeUndefined()
    // 只拦这一个：搜索类密钥不锁任何输入框，拦掉只会悄悄弄坏用户既有配置。
    expect(env.EXA_API_KEY).toBe('exa')
    expect(env.PATH).toBe('p')
  })

  it('Existing Home 下原样透传：那是用户自己的 Home，行为要与 `dsh web` 一致', () => {
    const env = inheritedEnv(false, { DEEPSEEK_API_KEY: 'sk-host' })
    expect(env[MANAGED_HOME_BLOCKED_ENV]).toBe('sk-host')
  })

  it('绝不改动调用方传入的环境对象', () => {
    const base: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: 'sk-host' }
    inheritedEnv(true, base)
    expect(base[MANAGED_HOME_BLOCKED_ENV]).toBe('sk-host')
  })
})

describe('ensurePluginResolvable 重建链接时不碰旧目标（2026-08-23 实机灾难回归）', () => {
  it('换安装位置重建 junction：旧目标目录的内容必须原封不动', () => {
    // 灾难原型：rmSync({recursive:true}) 摘旧链接时跟进 junction，把旧安装
    // （当时是桌面 win-unpacked）里的插件真身掏空——此后打出的每个安装包
    // 都带着空插件，用户启动必崩 page-load，现场毫无线索指向这里。
    const root = mkdtempSync(join(tmpdir(), 'dsh-link-'))
    try {
      const oldTarget = join(root, 'old-install', 'plugin')
      const newTarget = join(root, 'new-install', 'plugin')
      mkdirSync(oldTarget, { recursive: true })
      mkdirSync(newTarget, { recursive: true })
      writeFileSync(join(oldTarget, 'index.js'), 'old body')
      writeFileSync(join(newTarget, 'index.js'), 'new body')
      const home = join(root, 'home')
      const link = join(home, 'profiles', 'node_modules', '@scope', 'plugin')
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(oldTarget, link, 'junction')

      expect(ensurePluginResolvable(home, newTarget, '@scope/plugin')).toBe(true)

      // 链接指向新目标
      expect(realpathSync(link)).toBe(realpathSync(newTarget))
      // 旧目标毫发无损——这行就是整个回归的靶心
      expect(readFileSync(join(oldTarget, 'index.js'), 'utf8')).toBe('old body')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('占位是真实非空目录（不是链接）：放弃而不是删别人的目录', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-link-'))
    try {
      const target = join(root, 'install', 'plugin')
      mkdirSync(target, { recursive: true })
      const home = join(root, 'home')
      const occupied = join(home, 'profiles', 'node_modules', '@scope', 'plugin')
      mkdirSync(occupied, { recursive: true })
      writeFileSync(join(occupied, 'user-file.txt'), 'not ours')

      expect(ensurePluginResolvable(home, target, '@scope/plugin')).toBe(false)
      expect(readFileSync(join(occupied, 'user-file.txt'), 'utf8')).toBe('not ours')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})


describe('waitForServer 的总超时必须真的生效', () => {
  const openSockets: import('node:net').Socket[] = []
  let silent: import('node:net').Server | undefined

  afterEach(async () => {
    for (const socket of openSockets.splice(0)) socket.destroy()
    if (silent !== undefined) {
      await new Promise<void>((done) => { silent?.close(() => { done() }) })
      silent = undefined
    }
  })

  it('端口能连上但服务永不写响应：仍在总超时内失败', async () => {
    // 这是原先那个洞的复现：fetch 没有 signal，服务端接了连接却不回，
    // 于是 promise 永远 pending，deadline 检查永远轮不到。改之前这个
    // 用例会一直挂到测试框架超时。
    const net = await import('node:net')
    silent = net.createServer((socket) => { openSockets.push(socket) })
    await new Promise<void>((done) => { silent?.listen(0, '127.0.0.1', () => { done() }) })
    const port = (silent.address() as AddressInfo).port

    const startedAt = Date.now()
    await expect(waitForServer('127.0.0.1', port, 600)).rejects.toThrow(/未就绪/)
    const elapsed = Date.now() - startedAt
    // 允许调度抖动，但必须是"按时失败"而不是"挂死"。
    expect(elapsed).toBeLessThan(4_000)
  })

  it('连接被拒绝：按重试节奏走，到点失败', async () => {
    // 没有任何东西监听的端口：每次 probe 立即 ECONNREFUSED，重试到总超时。
    const startedAt = Date.now()
    await expect(waitForServer('127.0.0.1', 1, 400)).rejects.toThrow(/未就绪/)
    expect(Date.now() - startedAt).toBeLessThan(4_000)
  })

  it('迟到的响应不能突破总超时', async () => {
    const http = await import('node:http')
    const late = http.createServer((_request, response) => {
      // 远晚于总超时才回应。
      setTimeout(() => { response.end('ok') }, 5_000).unref()
    })
    await new Promise<void>((done) => { late.listen(0, '127.0.0.1', () => { done() }) })
    const port = (late.address() as AddressInfo).port
    try {
      const startedAt = Date.now()
      await expect(waitForServer('127.0.0.1', port, 500)).rejects.toThrow(/未就绪/)
      expect(Date.now() - startedAt).toBeLessThan(4_000)
    } finally {
      late.closeAllConnections()
      await new Promise<void>((done) => { late.close(() => { done() }) })
    }
  })

  it('服务正常：立刻就绪', async () => {
    const http = await import('node:http')
    const ok = http.createServer((_request, response) => { response.end('ok') })
    await new Promise<void>((done) => { ok.listen(0, '127.0.0.1', () => { done() }) })
    const port = (ok.address() as AddressInfo).port
    try {
      await expect(waitForServer('127.0.0.1', port, 5_000)).resolves.toBeUndefined()
    } finally {
      ok.closeAllConnections()
      await new Promise<void>((done) => { ok.close(() => { done() }) })
    }
  })

  it('单次探测上限是个正数，且不长于默认总超时', () => {
    expect(PROBE_TIMEOUT_MS).toBeGreaterThan(0)
    expect(PROBE_TIMEOUT_MS).toBeLessThan(READY_TIMEOUT_MS)
  })
})

describe('停不下来的子进程必须明确失败，而不是永远等下去', () => {
  /** 一个装死的子进程：永远不发 exit，kill 也毫无作用。 */
  const stubbornChild = (): ChildProcess => {
    const emitter = new EventEmitter()
    return Object.assign(emitter, {
      exitCode: null,
      signalCode: null,
      pid: 999_999,
      kill: () => true,
    }) as unknown as ChildProcess
  }

  /** taskkill 报告成功，但目标其实纹丝不动。 */
  const uselessTreeKill = (): ChildProcess => {
    const emitter = new EventEmitter()
    setTimeout(() => { emitter.emit('exit', 0) }, 5).unref()
    return emitter as unknown as ChildProcess
  }

  it('到最终期限还没退出 → 抛 ProcessStopError（旧实现会一直挂着）', async () => {
    const startedAt = Date.now()
    await expect(stopProcess(stubbornChild(), 20, uselessTreeKill, 300))
      .rejects.toThrow(ProcessStopError)
    expect(Date.now() - startedAt).toBeLessThan(3_000)
  })

  it('错误里带得上 pid，诊断时能对上号', async () => {
    await expect(stopProcess(stubbornChild(), 20, uselessTreeKill, 200))
      .rejects.toThrow(/999999|999_999/)
  })

  it('正常退出的进程不受影响（最终期限只是兜底）', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    await expect(stopProcess(child, 2_000)).resolves.toBeUndefined()
  })
})
