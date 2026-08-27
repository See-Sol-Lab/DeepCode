/**
 * native-plugin-proof e2e：真实第三方 Cordis 插件证据链。
 * 测试 builder 在临时 Existing DSH_HOME 下预呈现一个已安装的 profile-local
 * package（复制文件即安装形态，不跑 pnpm install），profile 用正常
 * dsh.profile.bundles + cordis.patch.yml insert row 挂载它；先证明 boot-free
 * discovery 不产生 marker，再经 launcher selection → official dsh boot →
 * profile composition 等待 marker，断言 marker pid 等于实际 DSH child pid、
 * DSH_HOME 等于 Existing Home、nonce 匹配；负例覆盖删行无 marker 与
 * apply throw → lastKnownGood 回退；全程断言 profile 与 fixture 文件字节
 * 不变。不调用模型、不要求 API key。
 * @module @see-sol-lab/deepseekgui/tests/native-plugin-proof
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessController } from '../src/harness-controller.ts'
import { createLauncherStateStore, type HarnessSelection, type LauncherStateV1 } from '../src/launcher-state.ts'
import { discoverProfiles } from '../src/profile-discovery.ts'
import { repoRoot, resolveDshCommand, stopProcess, waitForServer } from '../src/dsh-service.ts'

/** fixture 包：不是 workspace 包，生产代码从不 import，打包 runtime 不当内置。 */
const FIXTURE_PACKAGE_DIR = fileURLToPath(new URL('./fixtures/native-proof-plugin/', import.meta.url))
const PLUGIN_PACKAGE_NAME = 'deepseekgui-native-proof-plugin'

/** marker 内容（只由 fixture 的 apply(ctx, config) 产生）。 */
interface Marker {
  nonce: string
  plugin: string
  pid: number
  ppid: number
  dshHome: string | null
}

const cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 取一个空闲的 loopback 端口（fixture 的就绪门）。 */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(resolve => server.close(() =>{  resolve() }))
  return port
}

/** 把 fixture 包预呈现为 profile-local node_modules 里的已安装形态（复制，不跑 pnpm）。 */
function installFixtureInto(profileDir: string): void {
  const dir = join(profileDir, 'node_modules', PLUGIN_PACKAGE_NAME)
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(FIXTURE_PACKAGE_DIR, 'package.json'), join(dir, 'package.json'))
  copyFileSync(join(FIXTURE_PACKAGE_DIR, 'plugin.js'), join(dir, 'plugin.js'))
}

interface StageOptions {
  throwOnApply?: boolean
  port?: number
  markerPath?: string
  nonce?: string
  /** false 时只写空 patch（删 insert row 的负例）。 */
  withRow?: boolean
}

/** 测试 builder：真实 profiles/<name>/package.json + cordis.patch.yml + 本地安装。 */
function stageProfile(home: string, name: string, options: StageOptions = {}): string {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, undefined, 2)}\n`)
  const row = options.withRow === false
    ? []
    : [
      '- insert:',
      `    - id: native-proof-${name}`,
      `      name: '${PLUGIN_PACKAGE_NAME}'`,
      '      config:',
      `        throw: ${options.throwOnApply === true}`,
      ...options.markerPath === undefined ? [] : [`        markerPath: ${JSON.stringify(options.markerPath)}`],
      ...options.nonce === undefined ? [] : [`        nonce: ${JSON.stringify(options.nonce)}`],
      ...options.port === undefined ? [] : [`        port: ${options.port}`],
    ]
  writeFileSync(join(dir, 'cordis.patch.yml'), `${row.join('\n')}\n`)
  installFixtureInto(dir)
  return dir
}

/** 用 DeepSeekGUI 的 launcher 向量（dev 官方 dsh 入口）启动一个 profile。 */
function launchProfile(home: string, profile: string): { child: ChildProcess; stderr: () => string } {
  const launch = resolveDshCommand({
    packaged: false,
    root: repoRoot(),
    dshHome: home,
    args: ['--profile', profile],
    nodeExecutable: process.execPath,
  })
  let stderr = ''
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  return { child, stderr: () => stderr }
}

/** 轮询等待 marker 出现并解析。 */
async function waitForMarker(path: string, timeoutMs = 20_000): Promise<Marker> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Marker
    } catch {
      if (Date.now() >= deadline) throw new Error(`marker ${path} 未在 ${timeoutMs}ms 内出现`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}

/** 字节快照：profile 与 fixture 的四个关键文件。 */
function snapshot(profileDir: string): { file: string; content: string }[] {
  return [
    join(profileDir, 'package.json'),
    join(profileDir, 'cordis.patch.yml'),
    join(profileDir, 'node_modules', PLUGIN_PACKAGE_NAME, 'package.json'),
    join(profileDir, 'node_modules', PLUGIN_PACKAGE_NAME, 'plugin.js'),
  ].map(file => ({ file, content: readFileSync(file, 'utf8') }))
}

describe('第三方 Cordis 插件证据链', () => {
  it('discovery 不产生 marker；launcher selection → 官方 boot 挂载 fixture；marker 与真实子进程一致', async () => {
    const home = join(mkdtempSync(join(tmpdir(), 'dsh-proof-home-')), '深 度 proof home')
    mkdirSync(home, { recursive: true })
    cleanups.push(home)
    const nonce = randomUUID()
    const markerPath = join(home, 'native-proof-marker.json')
    const goodDir = stageProfile(home, 'proof-good', { markerPath, nonce })
    stageProfile(home, 'proof-throw', {
      throwOnApply: true,
      markerPath: join(home, 'should-never-exist.json'),
      nonce: randomUUID(),
    })
    const before = snapshot(goodDir)

    // 1. boot-free discovery：只读组合，绝不挂载插件、不产生 marker。
    const discovery = await discoverProfiles({
      packaged: false,
      root: repoRoot(),
      dshHome: home,
      nodeExecutable: process.execPath,
      timeoutMs: 30_000,
    })
    expect(discovery.dshHome).toBe(home)
    expect(discovery.profiles.map(profile => [profile.name, profile.staticStatus])).toEqual([
      ['proof-good', 'candidate'],
      ['proof-throw', 'candidate'],
    ])
    expect(existsSync(markerPath)).toBe(false)

    // 2. launcher selection → official dsh boot → profile composition：
    //    marker 只能来自 fixture 的 apply(ctx, config)。
    const { child } = launchProfile(home, 'proof-good')
    try {
      expect(child.pid).toBeTypeOf('number')
      const marker = await waitForMarker(markerPath)
      expect(marker.pid).toBe(child.pid) // marker 由真实 DSH 子进程写出
      expect(marker.ppid).toBe(process.pid)
      expect(marker.dshHome).toBe(home) // Existing Home 原样进入子进程环境
      expect(marker.nonce).toBe(nonce)
      expect(marker.plugin).toBe(PLUGIN_PACKAGE_NAME)
    } finally {
      await stopProcess(child, 5_000)
    }

    // 3. boot/discovery 前后 profile 定义与 fixture 文件字节不变。
    for (const { file, content } of before) {
      expect(readFileSync(file, 'utf8'), file).toBe(content)
    }
  }, 60_000)

  it('删掉 insert row：fixture 不挂载、不产生 marker', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-proof-norow-'))
    cleanups.push(home)
    const markerPath = join(home, 'no-row-marker.json')
    stageProfile(home, 'proof-norow', { withRow: false, markerPath, nonce: randomUUID() })
    const { child } = launchProfile(home, 'proof-norow')
    try {
      await new Promise(resolve => setTimeout(resolve, 1_500))
      expect(existsSync(markerPath)).toBe(false)
    } finally {
      await stopProcess(child, 5_000)
    }
  }, 60_000)

  it('plugin apply throw → pending 启动失败 → 单次回退 lastKnownGood（recovered）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-proof-fallback-'))
    cleanups.push(home)
    const userData = mkdtempSync(join(tmpdir(), 'dsh-proof-userdata-'))
    cleanups.push(userData)
    const nonce = randomUUID()
    const markerPath = join(home, 'fallback-marker.json')
    const port = await freePort()
    const goodDir = stageProfile(home, 'proof-good', { markerPath, nonce, port })
    const badDir = stageProfile(home, 'proof-throw', {
      throwOnApply: true,
      markerPath: join(home, 'never.json'),
      nonce: randomUUID(),
    })
    const beforeGood = snapshot(goodDir)
    const beforeBad = snapshot(badDir)

    const goodSelection: HarnessSelection = { home: { kind: 'existing', path: home }, profile: 'proof-good' }
    const badSelection: HarnessSelection = { home: { kind: 'existing', path: home }, profile: 'proof-throw' }
    const store = createLauncherStateStore(userData)
    store.write({
      schemaVersion: 1,
      active: goodSelection,
      lastKnownGood: goodSelection,
      pending: null,
      lastBootFailure: null,
      interruptedSwitch: null,
    } satisfies LauncherStateV1)

    let child: ChildProcess | undefined
    const controller = new HarnessController({
      store,
      resolveHome: selection => (selection.home.kind === 'managed' ? join(userData, 'dsh') : selection.home.path),
      runtime: {
        async spawnProcess(selection) {
          child = launchProfile(selection.dshHome, selection.profile).child
        },
        async waitReady() {
          const target = child
          if (target === undefined) throw new Error('DSH 子进程不存在，无法等待就绪')
          await new Promise<void>((resolve, reject) => {
            let settled = false
            const settle = (outcome: () => void): void => {
              if (settled) return
              settled = true
              target.off('exit', onExit)
              outcome()
            }
            const onExit = (): void =>{  settle(() =>{  reject(new Error('DSH 服务在就绪前退出')) }) }
            target.once('exit', onExit)
            void waitForServer('127.0.0.1', port, 10_000).then(
              () =>{  settle(resolve) },
              (error: unknown) =>{  settle(() => { reject(error instanceof Error ? error : new Error(String(error))) }) },
            )
          })
        },
        async loadPage() {},
        async stopProcess() {
          const target = child
          child = undefined
          if (target !== undefined) await stopProcess(target, 5_000)
        },
      },
      log: () => {},
    })

    // 初始启动 good：running + marker。
    await controller.start()
    expect(controller.status().phase).toBe('running')
    expect((await waitForMarker(markerPath)).nonce).toBe(nonce)

    // 切到 apply-throw profile：pending 失败 → 只回退一次 LKG。
    await controller.switchTo(badSelection)
    expect(controller.status()).toMatchObject({
      phase: 'running',
      recovered: true,
      selection: { profile: 'proof-good', dshHome: home },
    })
    const state = store.read()
    expect(state.active).toEqual(goodSelection)
    expect(state.lastKnownGood).toEqual(goodSelection)
    expect(state.pending).toBeNull()
    expect(state.lastBootFailure).toMatchObject({ stage: 'readiness', selection: badSelection })
    // fallback 的 good boot 再次写出 marker（同一 profile 配置、同一 nonce）。
    expect(existsSync(markerPath)).toBe(true)

    // 全程字节不变。
    for (const { file, content } of beforeGood) {
      expect(readFileSync(file, 'utf8'), file).toBe(content)
    }
    for (const { file, content } of beforeBad) {
      expect(readFileSync(file, 'utf8'), file).toBe(content)
    }

    await controller.stop()
    expect(controller.status().phase).toBe('idle')
  }, 120_000)
})
