/**
 * terminal-service 测试：argv 级 Profile 默认（显式优先/bare 注入/help
 * 不注入/Unicode）、终端宿主选择顺序（wt → PowerShell → cmd）、cwd
 * 解析（Profile 目录 → Harness Home + 说明）、welcome 事实、私有 shim
 * 内容（exact executable 转发、不引用系统安装）与 dsh-wrapper 的真实
 * spawn（注入/不注入/help 透传）。不涉及 Electron。
 * @module @see-sol-lab/deepseekgui/tests/terminal-service
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildTerminalWelcome,
  resolveTerminalCwd,
  resolveTerminalShell,
  terminalShimContents,
  type ShimRuntimeFacts,
} from '../src/terminal-service.ts'
import type { ProfileDiscoveryV1 } from '../src/profile-discovery.ts'

// argv 规则只有一份实现：真正被 shim 执行的 dsh-wrapper.cjs。测试直接
// require 它，杜绝"测的是 TS 镜像、跑的是 CJS"这种漂移。
const { resolveProfileArgv } = createRequire(import.meta.url)('../src/terminal/dsh-wrapper.cjs') as {
  resolveProfileArgv: (args: readonly string[], activeProfile: string) => string[]
}

let temp: string | undefined
afterEach(() => {
  if (temp !== undefined) rmSync(temp, { recursive: true, force: true })
  temp = undefined
})

const probe = (existing: string[]): { exists: (path: string) => boolean } => ({
  exists: path => existing.includes(path),
})

describe('resolveProfileArgv（argv 级 Profile 默认，对齐官方 CLI grammar）', () => {
  it('bare 启动与 launcher flags 开头 → 前置 --profile active', () => {
    expect(resolveProfileArgv([], 'web')).toEqual(['--profile', 'web'])
    expect(resolveProfileArgv(['--resume', 'abc'], 'tui')).toEqual(['--profile', 'tui', '--resume', 'abc'])
  })

  it('显式 --profile X 永远优先（任意位置、带值）', () => {
    expect(resolveProfileArgv(['--profile', 'tui', '--resume', 'x'], 'web')).toEqual(['--profile', 'tui', '--resume', 'x'])
    expect(resolveProfileArgv(['--host', '127.0.0.1', '--profile', 'headless'], 'web'))
      .toEqual(['--host', '127.0.0.1', '--profile', 'headless'])
  })

  it('显式 --profile=X 永远优先', () => {
    expect(resolveProfileArgv(['--profile=tui'], 'web')).toEqual(['--profile=tui'])
  })

  it('plugin 维护命令：注入插在 plugin 之后（plugin 自己的 requiredOption）', () => {
    expect(resolveProfileArgv(['plugin', 'add', 'pkg'], 'web'))
      .toEqual(['plugin', '--profile', 'web', 'add', 'pkg'])
    expect(resolveProfileArgv(['plugin', '--profile', 'tui', 'add', 'pkg'], 'web'))
      .toEqual(['plugin', '--profile', 'tui', 'add', 'pkg'])
  })

  it('profiles/web/未知子命令：官方 grammar 拒绝父级 --profile，绝不注入', () => {
    expect(resolveProfileArgv(['profiles', '--json'], 'web')).toEqual(['profiles', '--json'])
    expect(resolveProfileArgv(['web', '--patch', 'x.yml'], 'tui')).toEqual(['web', '--patch', 'x.yml'])
    expect(resolveProfileArgv(['some-command', 'x'], 'web')).toEqual(['some-command', 'x'])
  })

  it('help/version 不注入（否则 -h 语义会从 launcher help 变成 profile app help）', () => {
    expect(resolveProfileArgv(['-h'], 'web')).toEqual(['-h'])
    expect(resolveProfileArgv(['--help'], 'web')).toEqual(['--help'])
    expect(resolveProfileArgv(['--version'], 'web')).toEqual(['--version'])
    expect(resolveProfileArgv(['-V'], 'web')).toEqual(['-V'])
  })

  it('profile 名含空格/Unicode 原样保留', () => {
    expect(resolveProfileArgv([], '深 度 p')).toEqual(['--profile', '深 度 p'])
    expect(resolveProfileArgv(['--profile', '深 度 p'], 'web')).toEqual(['--profile', '深 度 p'])
  })

  it('绝不字符串替换：--profile 出现在参数值里不算显式', () => {
    // "--resume --profile" 的 --profile 后无值：不是合法显式形态，
    // 按 bare 注入（结构化扫描只认 --profile 后跟值 或 --profile=...）。
    expect(resolveProfileArgv(['--resume', '--profile'], 'web'))
      .toEqual(['--profile', 'web', '--resume', '--profile'])
  })
})

describe('resolveTerminalShell（wt → PowerShell → cmd）', () => {
  it('Windows Terminal 存在 → external wt，exact argv 空 + cwd 由调用方传', () => {
    const wt = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe'
    const choice = resolveTerminalShell(probe([wt]), 'C:\\Users\\me\\AppData\\Local')
    expect(choice).toEqual({ kind: 'external', label: 'Windows Terminal', executable: wt, args: [] })
  })

  it('wt absent → embedded PowerShell（System32 exact 路径）', () => {
    const choice = resolveTerminalShell(probe(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']), undefined)
    expect(choice.kind).toBe('embedded')
    expect(choice.executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(choice.args).toEqual(['-NoLogo'])
  })

  it('wt 与 PowerShell 都 absent → cmd（绝不无限 fallback）', () => {
    const choice = resolveTerminalShell(probe([]), undefined)
    expect(choice).toEqual({ kind: 'embedded', label: 'cmd', executable: 'C:\\Windows\\System32\\cmd.exe', args: ['/d'] })
  })
})

describe('resolveTerminalCwd（Profile 目录 → Harness Home + 说明）', () => {
  const discovery: ProfileDiscoveryV1 = {
    schemaVersion: 1,
    dshHome: 'C:\\home',
    profiles: [
      { name: 'web', dir: 'C:\\home\\profiles\\web', bundles: [], staticStatus: 'web-capable', evidence: [] },
    ],
  }

  it('active Profile 目录存在 → 用目录，无说明', () => {
    const choice = resolveTerminalCwd(discovery, 'web', 'C:\\home', path => path === 'C:\\home\\profiles\\web', 'zh')
    expect(choice).toEqual({ cwd: 'C:\\home\\profiles\\web', note: null })
  })

  it('目录不存在 → Harness Home + 说明（绝不锚到 install dir）；en 同样含 Harness Home', () => {
    const choice = resolveTerminalCwd(discovery, 'web', 'C:\\home', () => false, 'zh')
    expect(choice.cwd).toBe('C:\\home')
    expect(choice.note).toContain('Harness Home')
    const enChoice = resolveTerminalCwd(discovery, 'web', 'C:\\home', () => false, 'en')
    expect(enChoice.note).toContain('Harness Home')
  })

  it('discovery 未完成或没有该 Profile → Harness Home + 说明', () => {
    expect(resolveTerminalCwd(null, 'web', 'C:\\home', () => true, 'zh').cwd).toBe('C:\\home')
    expect(resolveTerminalCwd({ ...discovery, profiles: [] }, 'web', 'C:\\home', () => true, 'zh').note).toContain('Harness Home')
  })

  it('spaces/Unicode 目录原样保留', () => {
    const unicode: ProfileDiscoveryV1 = {
      schemaVersion: 1,
      dshHome: 'C:\\深 度 home',
      profiles: [{ name: 'web', dir: 'C:\\深 度 home\\我的 profile', bundles: [], staticStatus: 'web-capable', evidence: [] }],
    }
    const choice = resolveTerminalCwd(unicode, 'web', 'C:\\深 度 home', path => path === 'C:\\深 度 home\\我的 profile', 'zh')
    expect(choice.cwd).toBe('C:\\深 度 home\\我的 profile')
  })
})

describe('buildTerminalWelcome', () => {
  it('含 DeepSeekGUI/DSH/Profile/DSH_HOME/私有 Runtime 来源/宿主/cwd，cwd 回退加说明（zh 原样）', () => {
    const lines = buildTerminalWelcome({
      appVersion: '0.1.0-alpha.1',
      dshVersion: '0.1.0-rc.5',
      nodeVersion: 'v22.18.0',
      pnpmVersion: '11.7.0',
      activeProfile: 'web',
      dshHome: 'C:\\home',
      shellLabel: 'PowerShell',
      cwd: 'C:\\home',
      cwdNote: '未在 discovery 中找到当前 Profile 目录，已使用 Harness Home 作为工作目录。',
    }, 'zh')
    expect(lines.join('\n')).toContain('DeepSeekGUI 0.1.0-alpha.1')
    expect(lines.join('\n')).toContain('DSH 0.1.0-rc.5')
    expect(lines.join('\n')).toContain('Active Profile: web')
    expect(lines.join('\n')).toContain('DSH_HOME: C:\\home')
    expect(lines.join('\n')).toContain('全部来自 DeepSeekGUI 私有 Runtime')
    expect(lines.join('\n')).toContain('Terminal: PowerShell')
    expect(lines.join('\n')).toContain('已使用 Harness Home')
  })

  it('en welcome：引导行与 Runtime 来源为英文，事实行不变', () => {
    const lines = buildTerminalWelcome({
      appVersion: '0.1.0-alpha.1',
      dshVersion: '0.1.0-rc.5',
      nodeVersion: 'v22.18.0',
      pnpmVersion: '11.7.0',
      activeProfile: 'web',
      dshHome: 'C:\\home',
      shellLabel: 'PowerShell',
      cwd: 'C:\\home',
      cwdNote: null,
    }, 'en')
    const text = lines.join('\n')
    expect(text).toContain('DeepSeekGUI 0.1.0-alpha.1')
    expect(text).toContain('all from the DeepSeekGUI private runtime')
    expect(text).toContain('This command line is pre-configured with the DSH environment')
  })

  it('无 cwd 说明时不追加空行', () => {
    const lines = buildTerminalWelcome({
      appVersion: 'x', dshVersion: 'y', nodeVersion: 'v1', pnpmVersion: null,
      activeProfile: 'web', dshHome: 'H', shellLabel: 'cmd', cwd: 'C:\\p', cwdNote: null,
    }, 'zh')
    expect(lines.some(line => line === 'unknown')).toBe(false)
    expect(lines.join('\n')).toContain('pnpm unknown')
  })
})

describe('terminalShimContents（私有 shims）', () => {
  const facts: ShimRuntimeFacts = {
    nodeExecutable: 'E:\\app\\DeepSeekGUI.exe',
    nodePrefixArgs: ['--expose-internals'],
    dshWrapperPath: 'E:\\app\\resources\\app.asar\\src\\terminal\\dsh-wrapper.cjs',
    dshBin: 'E:\\app\\resources\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
    dshNodeArgs: ['--expose-internals'],
    pnpmArgs: ['--expose-internals', 'E:\\app\\resources\\dsh\\node_modules\\pnpm\\bin\\pnpm.cjs'],
    activeProfile: '深 度 p',
  }

  it('生成 node/dsh/pnpm 三个 shim，全部转发当前 exact executable', () => {
    const files = terminalShimContents(facts)
    expect([...files.keys()].sort()).toEqual(['dsh.cmd', 'node.cmd', 'pnpm.cmd'])
    for (const content of files.values()) {
      expect(content).toContain('E:\\app\\DeepSeekGUI.exe')
      // 绝不引用系统 Node/pnpm 或全局 PATH。
      expect(content).not.toMatch(/nodejs/i)
      expect(content).not.toContain('Program Files\\nodejs')
    }
  })

  it('dsh.cmd 转发 wrapper 并注入 active Profile 环境（Unicode 原样）', () => {
    const dsh = terminalShimContents(facts).get('dsh.cmd')!
    expect(dsh).toContain('dsh-wrapper.cjs')
    expect(dsh).toContain('set "DEEPSEEKGUI_ACTIVE_PROFILE=深 度 p"')
    expect(dsh).toContain('set "DEEPSEEKGUI_WRAPPER_NODE_ARGS=["--expose-internals"]"')
  })

  it('node.cmd 用 node 形态前缀 args 转发', () => {
    const node = terminalShimContents(facts).get('node.cmd')!
    expect(node).toContain('"E:\\app\\DeepSeekGUI.exe" --expose-internals %*')
  })
})

describe('dsh-wrapper 真实 spawn（argv 注入语义）', () => {
  const wrapper = join(process.cwd(), 'apps', 'desktop', 'src', 'terminal', 'dsh-wrapper.cjs')

  function runWrapper(userArgs: string[], activeProfile: string): { stdout: string; status: number | null } {
    temp = mkdtempSync(join(tmpdir(), 'dsh-wrapper-'))
    const echoer = join(temp, 'echoer.js')
    writeFileSync(echoer, 'console.log(JSON.stringify(process.argv.slice(2)))\n', 'utf8')
    const result = spawnSync(process.execPath, [wrapper, ...userArgs], {
      env: {
        ...process.env,
        DEEPSEEKGUI_WRAPPER_EXE: process.execPath,
        DEEPSEEKGUI_WRAPPER_DSH_BIN: echoer,
        DEEPSEEKGUI_WRAPPER_NODE_ARGS: '[]',
        DEEPSEEKGUI_ACTIVE_PROFILE: activeProfile,
      },
      encoding: 'utf8',
    })
    return { stdout: result.stdout.trim(), status: result.status }
  }

  it('bare dsh → 注入 --profile active', () => {
    const { stdout } = runWrapper([], 'web')
    expect(JSON.parse(stdout)).toEqual(['--profile', 'web'])
  })

  it('显式 --profile 优先', () => {
    const { stdout } = runWrapper(['--profile', 'tui', '--resume', 'x'], 'web')
    expect(JSON.parse(stdout)).toEqual(['--profile', 'tui', '--resume', 'x'])
  })

  it('plugin 注入插在 plugin 之后', () => {
    const { stdout } = runWrapper(['plugin', 'why', 'react'], 'web')
    expect(JSON.parse(stdout)).toEqual(['plugin', '--profile', 'web', 'why', 'react'])
  })

  it('profiles/web 子命令不注入', () => {
    expect(JSON.parse(runWrapper(['profiles', '--json'], 'web').stdout)).toEqual(['profiles', '--json'])
    expect(JSON.parse(runWrapper(['web', '--patch', 'x.yml'], 'tui').stdout)).toEqual(['web', '--patch', 'x.yml'])
  })

  it('help 不注入', () => {
    const { stdout } = runWrapper(['-h'], 'web')
    expect(JSON.parse(stdout)).toEqual(['-h'])
  })

  it('active Profile 含空格/Unicode 原样进入 argv', () => {
    const { stdout } = runWrapper(['--resume', 's1'], '深 度 p')
    expect(JSON.parse(stdout)).toEqual(['--profile', '深 度 p', '--resume', 's1'])
  })
})

describe('真实 CLI spawn（dev 入口 apps/cli/src/bin.ts）', () => {
  const CLI_BIN = join(process.cwd(), 'apps', 'cli', 'src', 'bin.ts')

  function runDsh(argv: string[], home: string) {
    return spawnSync(process.execPath, ['--import', 'tsx/esm', CLI_BIN, ...argv], {
      env: { ...process.env, DSH_HOME: home },
      encoding: 'utf8',
      timeout: 120_000,
    })
  }

  it('dsh profiles --json 不注入：真实 CLI 输出合法 JSON 文档、无 parent 拒绝', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-cli-profiles-'))
    try {
      const resolved = resolveProfileArgv(['profiles', '--json'], 'web')
      expect(resolved).toEqual(['profiles', '--json'])
      const result = runDsh(resolved, home)
      expect(result.stderr).not.toContain('takes none of parent')
      const doc = JSON.parse(result.stdout.trim()) as { schemaVersion?: number; profiles?: unknown }
      expect(doc.schemaVersion).toBe(1)
      expect(Array.isArray(doc.profiles)).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('bare plugin 注入后真实 CLI 不吃 parent 拒绝（等价只读 plugin 命令）', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-cli-plugin-'))
    try {
      // 最小 profile 目录（plugin 命令在 profile dir 里跑 pnpm）。
      const profileDir = join(home, 'profiles', 'tui')
      mkdirSync(profileDir, { recursive: true })
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-tui', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
      }, null, 2))
      const resolved = resolveProfileArgv(['plugin', 'why', 'react'], 'tui')
      expect(resolved).toEqual(['plugin', '--profile', 'tui', 'why', 'react'])
      const result = runDsh(resolved, home)
      expect(result.stderr).not.toContain('takes none of parent')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('显式 --profile 优先透传：真实 CLI 接受（launcher 层 --version 直接结算）', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-cli-explicit-'))
    try {
      const resolved = resolveProfileArgv(['--profile', 'tui', '--version'], 'web')
      expect(resolved).toEqual(['--profile', 'tui', '--version'])
      const result = runDsh(resolved, home)
      expect(result.stderr).not.toContain('takes none of parent')
      // 断言版本号的**形状**而不是具体值：这条要证明的是「launcher 层直接结算了
      // --version 并打印出来」，版本是多少与它要防的回归无关。写死 '0.1.0' 会在
      // 每次升级上游时假报失败——2026-08-22 升到 dsh-v0.1.1-rc.2 就红了一次，
      // 而红的原因跟 --profile 透传毫无关系。
      expect(result.stdout).toMatch(/\d+\.\d+\.\d+/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
