/**
 * launcher-state 纯逻辑测试：默认值、持久化与原子写入、严格 schema 校验
 * （未知版本/未知字段/非法 profile/非法 home）、spaces/Unicode 路径保留，
 * 以及 Managed/Existing selection 到 resolveDshLaunch 的完整参数向量。
 * 不涉及 Electron，可在普通 Node 环境下运行。
 * @module @see-sol-lab/deepcode/tests/launcher-state
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  backupInvalidLauncherState,
  createLauncherStateStore,
  BOOT_FAILURE_MAX_MESSAGE,
  defaultLauncherState,
  LAUNCHER_STATE_FILENAME,
  LauncherStateError,
  parseLauncherState,
  resolveHarnessHome,
  restoreDefaultLauncher,
  serializeLauncherState,
  type LauncherStateV1,
} from '../src/launcher-state.ts'
import { resolveDshLaunch } from '../src/dsh-service.ts'

let temp: string | undefined

afterEach(() => {
  if (temp !== undefined) rmSync(temp, { recursive: true, force: true })
  temp = undefined
})

/** 新建一个测试临时目录（绝对路径）。 */
function tempDir(): string {
  temp = mkdtempSync(join(tmpdir(), 'dsh-launcher-state-'))
  return temp
}

/** 构造状态文件的 JSON 文本。 */
function text(value: unknown): string {
  return JSON.stringify(value)
}

/** 合法的 existing selection 状态。 */
function existingState(homePath: string): LauncherStateV1 {
  return {
    schemaVersion: 1,
    active: { home: { kind: 'existing', path: homePath }, profile: 'web' },
    pending: { home: { kind: 'managed' }, profile: 'web' },
    lastKnownGood: null,
    lastBootFailure: null,
    interruptedSwitch: null,
  }
}

describe('defaultLauncherState', () => {
  it('默认 active 为 Managed Home + web，pending/lastKnownGood/lastBootFailure 为空', () => {
    expect(defaultLauncherState()).toEqual({
      schemaVersion: 1,
      active: { home: { kind: 'managed' }, profile: 'web' },
      pending: null,
      lastKnownGood: null,
      lastBootFailure: null,
      interruptedSwitch: null,
    })
  })
})

describe('createLauncherStateStore.read', () => {
  it('文件不存在时返回默认状态且不创建文件（新用户路径）', () => {
    const dir = tempDir()
    const store = createLauncherStateStore(dir)
    expect(store.filePath).toBe(join(dir, LAUNCHER_STATE_FILENAME))
    expect(store.read()).toEqual(defaultLauncherState())
    expect(existsSync(store.filePath)).toBe(false)
  })

  it('文件内容无效时抛 LauncherStateError，绝不回退默认值', () => {
    const dir = tempDir()
    const store = createLauncherStateStore(dir)
    writeFileSync(store.filePath, '{"schemaVersion":2,"active":null,"pending":null,"lastKnownGood":null,"lastBootFailure":null}', 'utf8')
    expect(() => store.read()).toThrow(/schemaVersion: 未知版本/)
  })
})

describe('createLauncherStateStore.write', () => {
  it('写入后精确读回（Managed selection 往返）', () => {
    const store = createLauncherStateStore(tempDir())
    store.write(defaultLauncherState())
    expect(store.read()).toEqual(defaultLauncherState())
  })

  it('写入后精确读回（Existing selection + spaces/Unicode 路径往返）', () => {
    const dir = tempDir()
    const home = join(dir, '我的 深度 数据 目录')
    const state = existingState(home)
    createLauncherStateStore(dir).write(state)
    expect(createLauncherStateStore(dir).read()).toEqual(state)
  })

  it('原子替换：目录里只有状态文件、无临时文件残留，内容为规范字节形式', () => {
    const dir = tempDir()
    const state = existingState(join(dir, 'existing home'))
    createLauncherStateStore(dir).write(state)
    expect(readdirSync(dir).sort()).toEqual([LAUNCHER_STATE_FILENAME])
    expect(readFileSync(join(dir, LAUNCHER_STATE_FILENAME), 'utf8')).toBe(serializeLauncherState(state))
  })

  it('覆盖写入同样原子替换（第二次 write 直接替换旧内容）', () => {
    const dir = tempDir()
    const store = createLauncherStateStore(dir)
    store.write(defaultLauncherState())
    store.write(existingState(join(dir, 'second home')))
    expect(readdirSync(dir).sort()).toEqual([LAUNCHER_STATE_FILENAME])
    expect(store.read()).toEqual(existingState(join(dir, 'second home')))
  })

  it('状态非法时抛 LauncherStateError 且不改动既有文件', () => {
    const dir = tempDir()
    const store = createLauncherStateStore(dir)
    store.write(defaultLauncherState())
    const before = readFileSync(store.filePath, 'utf8')
    const bad = {
      ...defaultLauncherState(),
      active: { home: { kind: 'existing', path: 'relative\\path' }, profile: 'web' },
    } as unknown as LauncherStateV1
    expect(() =>{  store.write(bad) }).toThrow(LauncherStateError)
    expect(readFileSync(store.filePath, 'utf8')).toBe(before)
  })

  it('lastBootFailure 非法时拒绝写入且不改动既有文件', () => {
    const dir = tempDir()
    const store = createLauncherStateStore(dir)
    store.write(defaultLauncherState())
    const before = readFileSync(store.filePath, 'utf8')
    const bad = {
      ...defaultLauncherState(),
      lastBootFailure: { stage: 'crash', message: 'x' },
    } as unknown as LauncherStateV1
    expect(() =>{  store.write(bad) }).toThrow(/lastBootFailure\.stage: 未知值/)
    expect(readFileSync(store.filePath, 'utf8')).toBe(before)
  })

  it('合法 BootFailure 写入并精确读回', () => {
    const dir = tempDir()
    const store = createLauncherStateStore(dir)
    const state: LauncherStateV1 = {
      ...defaultLauncherState(),
      lastBootFailure: { stage: 'readiness', message: 'DSH 服务在 60s 内未就绪' },
    }
    store.write(state)
    expect(store.read()).toEqual(state)
  })
})

describe('serializeLauncherState', () => {
  it('输出稳定键序、2 空格缩进、结尾一个换行', () => {
    expect(serializeLauncherState(defaultLauncherState())).toBe(
      '{\n'
      + '  "schemaVersion": 1,\n'
      + '  "active": {\n'
      + '    "home": {\n'
      + '      "kind": "managed"\n'
      + '    },\n'
      + '    "profile": "web"\n'
      + '  },\n'
      + '  "pending": null,\n'
      + '  "lastKnownGood": null,\n'
      + '  "lastBootFailure": null,\n'
      + '  "interruptedSwitch": null\n'
      + '}\n',
    )
  })

  it('Existing home 序列化为 kind + path', () => {
    const home = 'C:\\深 度\\my home'
    expect(serializeLauncherState(existingState(home))).toContain('"kind": "existing"')
    // JSON 文本中反斜杠被转义为 \\。
    expect(serializeLauncherState(existingState(home))).toContain('"path": "C:\\\\深 度\\\\my home"')
  })

  it('BootFailure 序列化为 stage + message 并精确往返', () => {
    const state: LauncherStateV1 = {
      ...defaultLauncherState(),
      lastBootFailure: { stage: 'spawn', message: 'boom' },
    }
    const content = serializeLauncherState(state)
    expect(content).toContain('"lastBootFailure": {')
    expect(content).toContain('"stage": "spawn"')
    expect(content).toContain('"message": "boom"')
    expect(parseLauncherState(content)).toEqual(state)
  })
})

describe('parseLauncherState 未知 schema', () => {
  it('未知版本（2）明确失败', () => {
    expect(() => parseLauncherState(text({
      schemaVersion: 2,
      active: { home: { kind: 'managed' }, profile: 'web' },
      pending: null,
      lastKnownGood: null,
      lastBootFailure: null,
      interruptedSwitch: null,
    }))).toThrow(/schemaVersion: 未知版本 2/)
  })

  it('版本缺失或类型错误明确失败', () => {
    expect(() => parseLauncherState(text({
      active: { home: { kind: 'managed' }, profile: 'web' },
      pending: null,
      lastKnownGood: null,
      lastBootFailure: null,
      interruptedSwitch: null,
    }))).toThrow(/schemaVersion: 未知版本/)
    expect(() => parseLauncherState('{"schemaVersion":"1","active":null,"pending":null,"lastKnownGood":null,"lastBootFailure":null}'))
      .toThrow(/schemaVersion: 未知版本/)
  })

  it('顶层不是对象明确失败', () => {
    expect(() => parseLauncherState('[]')).toThrow(/顶层: 必须是对象/)
    expect(() => parseLauncherState('null')).toThrow(/顶层: 必须是对象/)
    expect(() => parseLauncherState('42')).toThrow(/顶层: 必须是对象/)
  })

  it('JSON 语法错误明确失败', () => {
    expect(() => parseLauncherState('{not json')).toThrow(/不是有效 JSON/)
  })

  it('顶层未知字段明确失败', () => {
    expect(() => parseLauncherState(text({
      schemaVersion: 1,
      active: { home: { kind: 'managed' }, profile: 'web' },
      pending: null,
      lastKnownGood: null,
      lastBootFailure: null,
      interruptedSwitch: null,
      theme: 'dark',
    }))).toThrow(/顶层: 未知字段 "theme"/)
  })

  it('旧字段名 version 是未知字段，明确失败', () => {
    expect(() => parseLauncherState(text({
      version: 1,
      active: { home: { kind: 'managed' }, profile: 'web' },
      pending: null,
      lastKnownGood: null,
      lastBootFailure: null,
      interruptedSwitch: null,
    }))).toThrow(/顶层: 未知字段 "version"/)
  })

  it('active/pending/lastKnownGood/lastBootFailure 缺失明确失败', () => {
    expect(() => parseLauncherState(text({
      schemaVersion: 1,
      pending: null,
      lastKnownGood: null,
      lastBootFailure: null,
      interruptedSwitch: null,
    }))).toThrow(/active: 缺失/)
    expect(() => parseLauncherState(text({
      schemaVersion: 1,
      active: { home: { kind: 'managed' }, profile: 'web' },
      lastKnownGood: null,
      lastBootFailure: null,
      interruptedSwitch: null,
    }))).toThrow(/pending: 缺失/)
    expect(() => parseLauncherState(text({
      schemaVersion: 1,
      active: { home: { kind: 'managed' }, profile: 'web' },
      pending: null,
      lastBootFailure: null,
      interruptedSwitch: null,
    }))).toThrow(/lastKnownGood: 缺失/)
    expect(() => parseLauncherState(text({
      schemaVersion: 1,
      active: { home: { kind: 'managed' }, profile: 'web' },
      pending: null,
      lastKnownGood: null,
    }))).toThrow(/lastBootFailure: 缺失/)
  })

  it('lastBootFailure 非法形状明确失败', () => {
    expect(() => parseLauncherState(text({
      schemaVersion: 1,
      active: { home: { kind: 'managed' }, profile: 'web' },
      pending: null,
      lastKnownGood: null,
      lastBootFailure: 'x',
    }))).toThrow(/lastBootFailure: 必须是对象或 null/)
    expect(() => parseLauncherState(text({
      schemaVersion: 1,
      active: { home: { kind: 'managed' }, profile: 'web' },
      pending: null,
      lastKnownGood: null,
      lastBootFailure: { stage: 'crash', message: 'x' },
    }))).toThrow(/lastBootFailure\.stage: 未知值/)
    expect(() => parseLauncherState(text({
      schemaVersion: 1,
      active: { home: { kind: 'managed' }, profile: 'web' },
      pending: null,
      lastKnownGood: null,
      lastBootFailure: { stage: 'spawn' },
    }))).toThrow(/lastBootFailure\.message: 必须是非空字符串/)
    expect(() => parseLauncherState(text({
      schemaVersion: 1,
      active: { home: { kind: 'managed' }, profile: 'web' },
      pending: null,
      lastKnownGood: null,
      lastBootFailure: { stage: 'spawn', message: 'x', extra: 1 },
    }))).toThrow(/lastBootFailure: 未知字段 "extra"/)
    expect(() => parseLauncherState(text({
      schemaVersion: 1,
      active: { home: { kind: 'managed' }, profile: 'web' },
      pending: null,
      lastKnownGood: null,
      lastBootFailure: { stage: 'spawn', message: 'x'.repeat(BOOT_FAILURE_MAX_MESSAGE + 1) },
    }))).toThrow(/lastBootFailure\.message: 超过长度上限/)
  })

  it('合法 BootFailure 被接受并精确返回', () => {
    const parsed = parseLauncherState(text({
      schemaVersion: 1,
      active: { home: { kind: 'managed' }, profile: 'web' },
      pending: null,
      lastKnownGood: null,
      lastBootFailure: { stage: 'page-load', message: '页面加载失败' },
    }))
    expect(parsed.lastBootFailure).toEqual({ stage: 'page-load', message: '页面加载失败' })
  })

  it('interruptedSwitch：P7 之前的旧文件缺失该键 → 按 null（没有未完成的切换）', () => {
    const parsed = parseLauncherState(text({
      schemaVersion: 1,
      active: { home: { kind: 'managed' }, profile: 'web' },
      pending: null,
      lastKnownGood: null,
      lastBootFailure: null,
    }))
    expect(parsed.interruptedSwitch).toBeNull()
  })

  it('interruptedSwitch 合法值被接受并精确返回', () => {
    const parsed = parseLauncherState(text({
      schemaVersion: 1,
      active: { home: { kind: 'managed' }, profile: 'web' },
      pending: null,
      lastKnownGood: null,
      lastBootFailure: null,
      interruptedSwitch: { home: { kind: 'existing', path: 'C:\\h' }, profile: 'one' },
    }))
    expect(parsed.interruptedSwitch).toEqual({ home: { kind: 'existing', path: 'C:\\h' }, profile: 'one' })
  })

  it('interruptedSwitch 非法形状明确失败（与 selection 同一套校验）', () => {
    expect(() => parseLauncherState(text({
      schemaVersion: 1,
      active: { home: { kind: 'managed' }, profile: 'web' },
      pending: null,
      lastKnownGood: null,
      lastBootFailure: null,
      interruptedSwitch: 'one',
    }))).toThrow(/interruptedSwitch: 必须是对象/)
    expect(() => parseLauncherState(text({
      schemaVersion: 1,
      active: { home: { kind: 'managed' }, profile: 'web' },
      pending: null,
      lastKnownGood: null,
      lastBootFailure: null,
      interruptedSwitch: { home: { kind: 'managed' }, profile: 'a/b' },
    }))).toThrow(/interruptedSwitch\.profile: 非法 profile 名称/)
  })

  it('interruptedSwitch 序列化并精确往返', () => {
    const state: LauncherStateV1 = {
      ...defaultLauncherState(),
      interruptedSwitch: { home: { kind: 'existing', path: 'E:\\h' }, profile: 'one' },
    }
    const content = serializeLauncherState(state)
    expect(content).toContain('"interruptedSwitch": {')
    expect(parseLauncherState(content)).toEqual(state)
  })
})

describe('parseLauncherState profile 名称约束', () => {
  const withProfile = (profile: unknown): string => text({
    schemaVersion: 1,
    active: { home: { kind: 'managed' }, profile },
    pending: null,
    lastKnownGood: null,
    lastBootFailure: null,
    interruptedSwitch: null,
  })

  it.each(['web', 'headless', 'tui', 'my-custom', 'my custom', '深 度 profile'])('接受合法名称 %j', (profile) => {
    expect(parseLauncherState(withProfile(profile)).active.profile).toBe(profile)
  })

  it.each(['', 'a/b', 'a\\b', '.', '..', 'node_modules', 42, null])('拒绝非法名称 %j', (profile) => {
    expect(() => parseLauncherState(withProfile(profile))).toThrow(/active\.profile: 非法 profile 名称/)
  })

  it('selection 层未知字段明确失败', () => {
    expect(() => parseLauncherState(text({
      schemaVersion: 1,
      active: { home: { kind: 'managed' }, profile: 'web', extra: true },
      pending: null,
      lastKnownGood: null,
      lastBootFailure: null,
      interruptedSwitch: null,
    }))).toThrow(/active: 未知字段 "extra"/)
  })
})

describe('parseLauncherState 非法 home', () => {
  it.each(['cloud', 'existing2', ''])('kind=%j 明确失败', (kind) => {
    expect(() => parseLauncherState(text({
      schemaVersion: 1,
      active: { home: { kind }, profile: 'web' },
      pending: null,
      lastKnownGood: null,
      lastBootFailure: null,
      interruptedSwitch: null,
    }))).toThrow(/active\.home\.kind: 未知值/)
  })

  it('existing 缺 path 明确失败', () => {
    expect(() => parseLauncherState(text({
      schemaVersion: 1,
      active: { home: { kind: 'existing' }, profile: 'web' },
      pending: null,
      lastKnownGood: null,
      lastBootFailure: null,
      interruptedSwitch: null,
    }))).toThrow(/active\.home\.path: 必须是非空字符串/)
  })

  it.each(['relative\\dir', 'dir', './dir', '~/dsh'])('path=%j 非绝对路径明确失败', (path) => {
    expect(() => parseLauncherState(text({
      schemaVersion: 1,
      active: { home: { kind: 'existing', path }, profile: 'web' },
      pending: null,
      lastKnownGood: null,
      lastBootFailure: null,
      interruptedSwitch: null,
    }))).toThrow(/active\.home\.path: 必须是绝对路径/)
  })

  it('managed 携带 path 字段明确失败', () => {
    expect(() => parseLauncherState(text({
      schemaVersion: 1,
      active: { home: { kind: 'managed', path: 'C:\\x' }, profile: 'web' },
      pending: null,
      lastKnownGood: null,
      lastBootFailure: null,
      interruptedSwitch: null,
    }))).toThrow(/active\.home: 未知字段 "path"/)
  })

  it('pending 非法时同样明确失败', () => {
    expect(() => parseLauncherState(text({
      schemaVersion: 1,
      active: { home: { kind: 'managed' }, profile: 'web' },
      pending: { home: { kind: 'cloud' }, profile: 'web' },
      lastKnownGood: null,
      lastBootFailure: null,
      interruptedSwitch: null,
    }))).toThrow(/pending\.home\.kind: 未知值/)
  })
})

describe('resolveHarnessHome', () => {
  it('Managed 解析为 join(userData, "dsh")', () => {
    expect(resolveHarnessHome({ kind: 'managed' }, 'C:\\Users\\alice\\AppData\\Roaming\\DeepCode'))
      .toBe(join('C:\\Users\\alice\\AppData\\Roaming\\DeepCode', 'dsh'))
  })

  it('Existing 原样返回显式绝对路径（含 spaces/Unicode），不创建目录', () => {
    const home = join(tempDir(), '既有 DSH 之家')
    expect(resolveHarnessHome({ kind: 'existing', path: home }, 'anywhere'))
      .toBe(home)
    expect(existsSync(home)).toBe(false)
  })
})

describe('Managed/Existing 参数向量（selection → resolveDshLaunch）', () => {
  it('默认 Managed selection：dev 向量带 --profile web 与 userData/dsh 的 DSH_HOME', () => {
    const state = defaultLauncherState()
    const userData = 'C:\\Users\\alice\\AppData\\Roaming\\DeepCode'
    const { args, env } = resolveDshLaunch({
      packaged: false,
      root: 'R:\\repo',
      nodeExecutable: 'C:\\node.exe',
      profile: state.active.profile,
      dshHome: resolveHarnessHome(state.active.home, userData),
    })
    expect(args).toContain('--profile')
    expect(args[args.indexOf('--profile') + 1]).toBe('web')
    expect(env.DSH_HOME).toBe(join(userData, 'dsh'))
  })

  it('Existing selection（spaces/Unicode 绝对路径）：packaged 向量原样注入 DSH_HOME', () => {
    const home = join(tempDir(), '深度 数据 之家')
    const state = existingState(home)
    const { args, env, command } = resolveDshLaunch({
      packaged: true,
      packagedExecutable: 'E:\\app\\DeepCode.exe',
      resourcesPath: 'E:\\app\\resources',
      packagedCwd: 'E:\\',
      profile: state.active.profile,
      dshHome: resolveHarnessHome(state.active.home, 'unused-userdata'),
    })
    expect(command).toBe('E:\\app\\DeepCode.exe')
    expect(args).toEqual([
      '--expose-internals',
      'E:\\app\\resources\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
      '--profile', 'web',
      '--host', '127.0.0.1',
      '--port', '3080',
    ])
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(env.DSH_HOME).toBe(home)
  })
})

describe('backupInvalidLauncherState（救援备份）', () => {
  it('原样备份为 .invalid-<timestamp>，原文件字节不动', () => {
    const dir = tempDir()
    const path = join(dir, 'launcher-state.json')
    const content = '{"schemaVersion":99,"broken":true}'
    writeFileSync(path, content, 'utf8')
    const backup = backupInvalidLauncherState(path, () => 1700000000123)
    expect(backup).toBe(join(dir, 'launcher-state.json.invalid-1700000000123'))
    expect(readFileSync(backup, 'utf8')).toBe(content)
    expect(readFileSync(path, 'utf8')).toBe(content)
  })

  it('目标文件缺失时备份失败且不产生任何文件', () => {
    const dir = tempDir()
    const path = join(dir, 'launcher-state.json')
    expect(() => backupInvalidLauncherState(path, () => 42)).toThrow(/备份失败/)
    expect(readdirSync(dir)).toEqual([])
  })

  it('spaces/Unicode 文件名与目录正常备份', () => {
    const dir = join(tempDir(), '深度 之家')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'launcher-state.json')
    writeFileSync(path, '{broken', 'utf8')
    const backup = backupInvalidLauncherState(path, () => 7)
    expect(readFileSync(backup, 'utf8')).toBe('{broken')
  })
})

describe('restoreDefaultLauncher（救援恢复默认）', () => {
  it('先原样备份，再原子写默认状态（默认 = Managed/web）', () => {
    const dir = tempDir()
    const path = join(dir, 'launcher-state.json')
    writeFileSync(path, '{"schemaVersion":99}', 'utf8')
    const store = createLauncherStateStore(dir)
    const backup = restoreDefaultLauncher(path, store, () => 1700000000999)
    expect(backup).toBe(join(dir, 'launcher-state.json.invalid-1700000000999'))
    expect(readFileSync(backup, 'utf8')).toBe('{"schemaVersion":99}')
    expect(store.read()).toEqual(defaultLauncherState())
    expect(readFileSync(path, 'utf8')).toBe(serializeLauncherState(defaultLauncherState()))
  })

  it('备份失败：明确抛错且绝不写默认（原文件不动）', () => {
    const dir = tempDir()
    const path = join(dir, 'launcher-state.json')
    // 文件不存在 → 备份必然失败。
    const writes = vi.fn(() => { throw new Error('write 不应被调用') })
    expect(() => restoreDefaultLauncher(path, { write: writes }, () => 1)).toThrow(/备份失败/)
    expect(writes).not.toHaveBeenCalled()
    expect(existsSync(path)).toBe(false)
  })

  it('写入失败：备份已存在、默认写入失败也明确抛错', () => {
    const dir = tempDir()
    const path = join(dir, 'launcher-state.json')
    writeFileSync(path, '{broken', 'utf8')
    expect(() => restoreDefaultLauncher(path, {
      write: vi.fn(() => { throw new LauncherStateError('写入失败: disk full') }),
    }, () => 2)).toThrow(/写入失败/)
    // 备份已经原样产生，坏文件仍在原位。
    expect(readFileSync(join(dir, 'launcher-state.json.invalid-2'), 'utf8')).toBe('{broken')
    expect(readFileSync(path, 'utf8')).toBe('{broken')
  })
})
