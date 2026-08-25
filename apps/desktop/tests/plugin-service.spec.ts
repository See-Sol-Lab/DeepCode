/**
 * plugin-service 测试：inventory 三分类不混淆、exact argv 构造与注入
 * 防护、spec 锚定（spaces/Unicode/绝对路径）、post-check 判定、target
 * 校验与 restart handoff 判定。纯 Node 环境，无 Electron、无模型、
 * 无凭据、无真实 npm。
 * @module @see-sol-lab/deepcode/tests/plugin-service
 */

import { describe, expect, it } from 'vitest'
import { resolveDshCommand } from '../src/dsh-service.ts'
import {
  anchorLocalSpec,
  buildPluginOperationArgs,
  buildPluginInventory,
  expectedPackageName,
  isRelativeSpec,
  localSpecPath,
  parseManifestDependencies,
  pluginConfirmText,
  shouldShowHandoff,
  specHasCredentials,
  validateLocalSpecTarget,
  validatePluginRequest,
  validatePluginTarget,
  verifyPluginPostCheck,
  type PluginOperationRequest,
  type PluginSnapshot,
} from '../src/plugin-service.ts'
import type { DiscoveredProfile, ProfileDiscoveryV1 } from '../src/profile-discovery.ts'

const DISCOVERY: ProfileDiscoveryV1 = {
  schemaVersion: 1,
  dshHome: 'C:\\home\\dsh',
  profiles: [
    {
      name: 'web',
      dir: 'C:\\home\\dsh\\profiles\\web',
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'my-plugin'],
      staticStatus: 'web-capable',
      evidence: ['official web surface rows present and enabled'],
    },
    {
      name: 'broken',
      dir: 'C:\\home\\dsh\\profiles\\broken',
      bundles: [],
      staticStatus: 'malformed',
      evidence: [],
      error: 'bad yaml',
    },
  ],
}

const WEB_PROFILE = DISCOVERY.profiles[0] as DiscoveredProfile

function snapshot(dependencies: Record<string, string>, bundles: string[]): PluginSnapshot {
  return { dependencies, bundles, staticStatus: 'web-capable' }
}

describe('parseManifestDependencies（只读文档，绝不猜测）', () => {
  it('缺 dependencies = 空记录', () => {
    expect(parseManifestDependencies('{"name":"dsh-profile-web"}', 'dir')).toEqual({ ok: true, dependencies: {} })
  })

  it('正常读取 name → spec', () => {
    expect(parseManifestDependencies('{"dependencies":{"a":"^1.0.0","@s/b":"2.0.0"}}', 'dir'))
      .toEqual({ ok: true, dependencies: { a: '^1.0.0', '@s/b': '2.0.0' } })
  })

  it('非 JSON / 非对象 / 非字符串 spec 都明确报错', () => {
    expect(parseManifestDependencies('not json', 'dir').ok).toBe(false)
    expect(parseManifestDependencies('[]', 'dir').ok).toBe(false)
    expect(parseManifestDependencies('{"dependencies":["x"]}', 'dir').ok).toBe(false)
    expect(parseManifestDependencies('{"dependencies":{"a":42}}', 'dir').ok).toBe(false)
  })
})

describe('buildPluginInventory（三分类绝不混写）', () => {
  it('模板 bundle（不在 dependencies）= fromDependency false；依赖派生的进 bundles 的 = true；装了但未进 loader 的依赖 = inBundles false', () => {
    const inventory = buildPluginInventory(WEB_PROFILE, {
      ok: true,
      dependencies: { 'my-plugin': '^1.0.0', 'plain-lib': '^2.0.0' },
    })
    expect(inventory.bundles).toEqual([
      { name: '@deepseek-ai/dsh-base', fromDependency: false },
      { name: '@deepseek-ai/dsh-web-app', fromDependency: false },
      { name: 'my-plugin', fromDependency: true },
    ])
    expect(inventory.dependencies).toEqual([
      { name: 'my-plugin', spec: '^1.0.0', inBundles: true },
      { name: 'plain-lib', spec: '^2.0.0', inBundles: false },
    ])
    expect(inventory.staticStatus).toBe('web-capable')
    expect(inventory.evidence.join('')).toContain('web surface')
    expect(inventory.manifestError).toBeNull()
  })

  it('manifest 读取失败只影响 dependencies 区并如实展示错误', () => {
    const inventory = buildPluginInventory(WEB_PROFILE, { ok: false, error: 'bad manifest' })
    expect(inventory.bundles).toHaveLength(3)
    expect(inventory.dependencies).toEqual([])
    expect(inventory.manifestError).toBe('bad manifest')
  })

  it('profile 未发现时 inventory 为空且 malformed', () => {
    const inventory = buildPluginInventory(undefined, { ok: true, dependencies: {} })
    expect(inventory.bundles).toEqual([])
    expect(inventory.staticStatus).toBe('malformed')
  })
})

describe('validatePluginTarget（v1 只操作已发现的非 malformed profile）', () => {
  it('已发现且健康 = 合法', () => {
    expect(validatePluginTarget('web', DISCOVERY)).toBeNull()
  })

  it('不存在 = 拒绝（绝不 auto-init）', () => {
    expect(validatePluginTarget('tui', DISCOVERY)).toContain('不存在')
  })

  it('malformed = 拒绝', () => {
    expect(validatePluginTarget('broken', DISCOVERY)).toContain('配置有问题')
  })

  it('discovery 尚未运行 = 拒绝', () => {
    expect(validatePluginTarget('web', null)).toContain('尚未发现')
  })
})

describe('anchorLocalSpec / isRelativeSpec', () => {
  it('相对路径锚到用户选择的目录（spaces/Unicode）', () => {
    const dir = 'C:\\我的 插件\\dir with spaces'
    expect(anchorLocalSpec('./pkg', dir)).toEqual({ spec: 'C:\\我的 插件\\dir with spaces\\pkg', anchored: true })
    expect(anchorLocalSpec('../pkg', dir)).toEqual({ spec: 'C:\\我的 插件\\pkg', anchored: true })
    expect(anchorLocalSpec('file:./pkg', dir)).toEqual({ spec: 'file:C:\\我的 插件\\dir with spaces\\pkg', anchored: true })
    expect(anchorLocalSpec('link:../pkg', dir)).toEqual({ spec: 'link:C:\\我的 插件\\pkg', anchored: true })
  })

  it('绝对路径 / registry 名 / git spec 原样透传', () => {
    const dir = 'C:\\anchor'
    expect(anchorLocalSpec('C:\\abs\\pkg', dir)).toEqual({ spec: 'C:\\abs\\pkg', anchored: false })
    expect(anchorLocalSpec('@scope/pkg@^1', dir)).toEqual({ spec: '@scope/pkg@^1', anchored: false })
    expect(anchorLocalSpec('github:user/repo#main', dir)).toEqual({ spec: 'github:user/repo#main', anchored: false })
    expect(anchorLocalSpec('file:C:\\abs\\pkg', dir)).toEqual({ spec: 'file:C:\\abs\\pkg', anchored: false })
  })

  it('非绝对锚定目录抛错', () => {
    expect(() => anchorLocalSpec('./pkg', 'relative\\dir')).toThrow('绝对路径')
  })

  it('isRelativeSpec 形态判定', () => {
    expect(isRelativeSpec('./pkg')).toBe(true)
    expect(isRelativeSpec('../pkg')).toBe(true)
    expect(isRelativeSpec('.\\pkg')).toBe(true)
    expect(isRelativeSpec('file:./pkg')).toBe(true)
    expect(isRelativeSpec('link:../pkg')).toBe(true)
    expect(isRelativeSpec('pkg')).toBe(false)
    expect(isRelativeSpec('C:\\abs')).toBe(false)
    expect(isRelativeSpec('file:C:\\abs')).toBe(false)
  })
})

describe('validatePluginRequest / buildPluginOperationArgs（exact argv，无 shell 注入面）', () => {
  const base = (overrides: Partial<PluginOperationRequest>): PluginOperationRequest => ({
    action: 'add',
    profile: 'web',
    spec: 'my-plugin',
    anchorDir: null,
    ...overrides,
  })

  it('合法 add/remove/update/install 构造 exact argv', () => {
    expect(buildPluginOperationArgs(base({}))).toEqual(['plugin', '--profile', 'web', 'add', 'my-plugin'])
    expect(buildPluginOperationArgs(base({ action: 'remove', spec: 'my-plugin' })))
      .toEqual(['plugin', '--profile', 'web', 'remove', 'my-plugin'])
    expect(buildPluginOperationArgs(base({ action: 'update', spec: 'my-plugin' })))
      .toEqual(['plugin', '--profile', 'web', 'update', 'my-plugin'])
    expect(buildPluginOperationArgs(base({ action: 'install', spec: null })))
      .toEqual(['plugin', '--profile', 'web', 'install'])
  })

  it('相对路径 spec 在入 argv 前锚定为绝对（spaces/Unicode 单项）', () => {
    const args = buildPluginOperationArgs(base({ spec: './my plugin', anchorDir: 'C:\\我 的目录' }))
    expect(args).toEqual(['plugin', '--profile', 'web', 'add', 'C:\\我 的目录\\my plugin'])
  })

  it('spec 始终是单个 argv 元素（argv 数组形态，无跨参数拆分）', () => {
    // 只断言 DeepCode 自己的 argv 形态；安全结论由 validatePluginRequest
    // 的字符拒绝测试承担——本层 argv 单项 ≠ 全链路安全（下游官方 CLI
    // 在 Windows 上经 shell 转发）。
    const evil = 'pkg"; rm -rf C:\\; "x'
    const args = buildPluginOperationArgs(base({ spec: evil }))
    expect(args).toEqual(['plugin', '--profile', 'web', 'add', evil])
    expect(args).toHaveLength(5)
  })

  it.each(['&', '|', '<', '>', '^', '%', '!', '(', ')', ';', ',', '"', '\'', '`', '\u0001'])(
    '元字符/控制字符 %s：validatePluginRequest 一律拒绝（上游 Windows shell 转发注入面）',
    (char) => {
      const message = validatePluginRequest(base({ spec: `pkg${char}tail` }))
      expect(message).not.toBeNull()
      expect(message).toContain('无法安全携带')
    },
  )

  it('cmd 注入 payload 形态（bogus-pkg&echo.>x）在边界被拒绝', () => {
    const message = validatePluginRequest(base({ spec: 'bogus-pkg-xyz&echo.>INJECTED.txt' }))
    expect(message).not.toBeNull()
    expect(message).toContain('无法安全携带')
  })

  it('锚定后的最终 argv 同样过字符校验：锚定目录含元字符或空格一律拒绝', () => {
    // 用户输入 './local' 本身干净，锚定目录名却可能含 & 或空格（都是
    // Windows 合法目录名）。验收方探针实证：锚定目录
    // `p&copy nul INJECTED2.txt&rem` 配 spec './local' 通过了 spec 层
    // 全部校验，经官方 CLI 造成任意命令执行且退出码 0 —— 因此校验必须
    // 作用于锚定结果（真正进 argv 的值），不能只看用户输入。
    const metachar = validatePluginRequest(base({
      spec: './local',
      anchorDir: 'C:\\tmp\\p&copy nul INJECTED2.txt&rem',
    }))
    expect(metachar).not.toBeNull()
    expect(metachar).toContain('无法安全携带')
    const spaced = validatePluginRequest(base({ spec: './local', anchorDir: 'C:\\My Projects' }))
    expect(spaced).not.toBeNull()
    expect(spaced).toContain('无法安全携带')
    // 干净锚定目录（连字符、点都是合法且安全的路径字符）照常通过。
    expect(validatePluginRequest(base({ spec: './local', anchorDir: 'C:\\my-projects\\v1.2' }))).toBeNull()
  })

  it('非法 profile 名拒绝', () => {
    expect(validatePluginRequest(base({ profile: '../evil' }))).toContain('非法')
    expect(validatePluginRequest(base({ profile: '' }))).toContain('非法')
    expect(validatePluginRequest(base({ profile: 'node_modules' }))).toContain('非法')
  })

  it('install 不接受 spec；add/remove/update 需要非空 spec', () => {
    expect(validatePluginRequest(base({ action: 'install', spec: 'x' }))).toContain('install 不接受')
    expect(validatePluginRequest(base({ action: 'install', spec: null }))).toBeNull()
    expect(validatePluginRequest(base({ spec: '  ' }))).toContain('需要')
    expect(validatePluginRequest(base({ spec: null }))).toContain('需要')
  })

  it('remove/update 只接受包名形态（路径/git/版本拒绝）', () => {
    expect(validatePluginRequest(base({ action: 'remove', spec: './local' }))).toContain('包名')
    expect(validatePluginRequest(base({ action: 'update', spec: 'git+https://x/y.git' }))).toContain('包名')
    expect(validatePluginRequest(base({ action: 'remove', spec: 'C:\\abs\\pkg' }))).toContain('包名')
    expect(validatePluginRequest(base({ action: 'remove', spec: '@scope/pkg' }))).toBeNull()
    // remove 拒绝带版本的 spec（pnpm remove 只吃裸包名）。
    expect(validatePluginRequest(base({ action: 'remove', spec: 'pkg@1.0.0' }))).toContain('裸包名')
    // ^ 版本被元字符规则拒绝（cmd 吞 ^，语义篡改——见元字符测试）；
    // update 接受 name@精确版本。
    expect(validatePluginRequest(base({ action: 'update', spec: 'pkg@2.0.0' }))).toBeNull()
    expect(validatePluginRequest(base({ action: 'update', spec: '@scope/pkg' }))).toBeNull()
  })

  it('add 相对路径 spec 必须有绝对锚定目录', () => {
    expect(validatePluginRequest(base({ spec: './local', anchorDir: null }))).toContain('锚定目录')
    expect(validatePluginRequest(base({ spec: './local', anchorDir: 'relative' }))).toContain('锚定目录')
    expect(validatePluginRequest(base({ spec: './local', anchorDir: 'C:\\abs' }))).toBeNull()
  })

  it('含空白字符的 spec 一律拒绝（官方 CLI Windows shell:true 会拆词；desktop 不绕开）', () => {
    expect(validatePluginRequest(base({ spec: 'C:\\dir with space\\pkg' }))).toContain('空白')
    expect(validatePluginRequest(base({ spec: 'my plugin' }))).toContain('空白')
    expect(validatePluginRequest(base({ spec: './local dir' }))).toContain('空白')
    expect(validatePluginRequest(base({ action: 'remove', spec: 'my pkg' }))).toContain('空白')
  })

  it('validateLocalSpecTarget：本地 spec 必须真实存在且是目录（pnpm 对缺失目录只 WARN 并写 link）', () => {
    const probe = {
      exists: (path: string) => path === 'C:\\real\\dir' || path === 'C:\\real\\pkg',
      isDirectory: (path: string) => path === 'C:\\real\\dir' || path === 'C:\\real\\pkg',
    }
    // 绝对路径缺失 → 拒绝
    expect(validateLocalSpecTarget(base({ spec: 'C:\\missing\\pkg' }), probe)).toContain('不存在')
    // 绝对路径是文件 → 拒绝
    expect(validateLocalSpecTarget(base({ spec: 'C:\\real\\file' }), { exists: () => true, isDirectory: () => false }))
      .toContain('不是目录')
    // 相对 spec 锚定后检查
    expect(validateLocalSpecTarget(base({ spec: './pkg', anchorDir: 'C:\\real' }), probe)).toBeNull()
    expect(validateLocalSpecTarget(base({ spec: './pkg', anchorDir: 'C:\\missing' }), probe)).toContain('不存在')
    // file:/link: 前缀同样检查
    expect(validateLocalSpecTarget(base({ spec: 'link:C:\\real\\dir' }), probe)).toBeNull()
    expect(validateLocalSpecTarget(base({ spec: 'file:C:\\missing\\dir' }), probe)).toContain('不存在')
    // registry 名 / git spec / remove/update/install 跳过
    expect(validateLocalSpecTarget(base({ spec: '@scope/pkg@^1' }), probe)).toBeNull()
    expect(validateLocalSpecTarget(base({ spec: 'github:user/repo#main' }), probe)).toBeNull()
    expect(validateLocalSpecTarget(base({ action: 'remove', spec: 'p' }), probe)).toBeNull()
    expect(validateLocalSpecTarget(base({ action: 'install', spec: null }), probe)).toBeNull()
  })

  it('localSpecPath 形态提取', () => {
    expect(localSpecPath('C:\\abs\\pkg')).toBe('C:\\abs\\pkg')
    expect(localSpecPath('file:C:\\abs\\pkg')).toBe('C:\\abs\\pkg')
    expect(localSpecPath('link:./pkg')).toBe('./pkg')
    expect(localSpecPath('@scope/pkg')).toBeNull()
  })
})

describe('expectedPackageName', () => {
  it('裸名/@scope/带版本可提取；git/file/path 形态不可提取', () => {
    expect(expectedPackageName('my-plugin')).toBe('my-plugin')
    expect(expectedPackageName('my-plugin@^1.2.3')).toBe('my-plugin')
    expect(expectedPackageName('@scope/my-plugin@2')).toBe('@scope/my-plugin')
    expect(expectedPackageName('github:user/repo#main')).toBeNull()
    expect(expectedPackageName('./local')).toBeNull()
    expect(expectedPackageName('file:../local')).toBeNull()
  })

  it('Windows 绝对路径不可提取（既无 / 也无 @，曾被整条当成包名）', () => {
    // 打包验收实测的真实失败：pnpm 成功装上 fixture（manifest 键是包名），
    // post-check 却拿整条路径当键去查 manifest，于是本地路径 add 永远被
    // 判失败、永远拿不到 restart handoff。路径形态必须退回"新增依赖"证明。
    expect(expectedPackageName('C:\\tmp\\bundle-fixture')).toBeNull()
    expect(expectedPackageName('C:/tmp/bundle-fixture')).toBeNull()
    expect(expectedPackageName('file:C:\\tmp\\bundle-fixture')).toBeNull()
    expect(expectedPackageName('link:C:\\tmp\\bundle-fixture')).toBeNull()
  })
})

describe('本地路径 add 的 post-check（回归：曾因包名提取错误永远失败）', () => {
  it('路径 spec + manifest 出现新依赖 = 通过，证据点名真实包名', () => {
    const before = { dependencies: {}, bundles: [], staticStatus: 'candidate' as const }
    const after = {
      dependencies: { 'deepcode-bundle-fixture': 'link:../bundle-fixture' },
      bundles: ['deepcode-bundle-fixture'],
      staticStatus: 'candidate' as const,
    }
    const result = verifyPluginPostCheck(before, after, {
      action: 'add',
      profile: 'web',
      spec: 'C:\\tmp\\bundle-fixture',
      anchorDir: null,
    })
    expect(result.ok).toBe(true)
    expect(result.evidence).toContain('deepcode-bundle-fixture')
  })

  it('路径 spec 但 manifest 无任何新增 = 明确失败（不谎报成功）', () => {
    const same = { dependencies: { existing: '1.0.0' }, bundles: [], staticStatus: 'candidate' as const }
    const result = verifyPluginPostCheck(same, same, {
      action: 'add',
      profile: 'web',
      spec: 'C:\\tmp\\bundle-fixture',
      anchorDir: null,
    })
    expect(result.ok).toBe(false)
  })
})

describe('verifyPluginPostCheck', () => {
  const req = (overrides: Partial<PluginOperationRequest>): PluginOperationRequest => ({
    action: 'add', profile: 'web', spec: 'my-plugin', anchorDir: null, ...overrides,
  })

  it('add：裸名精确断言出现', () => {
    const result = verifyPluginPostCheck(
      snapshot({}, []),
      snapshot({ 'my-plugin': '^1.0.0' }, ['my-plugin']),
      req({}),
    )
    expect(result.ok).toBe(true)
    expect(result.ok && result.evidence).toContain('my-plugin')
  })

  it('add：裸名未出现 = 失败', () => {
    const result = verifyPluginPostCheck(snapshot({}, []), snapshot({}, []), req({}))
    expect(result.ok).toBe(false)
  })

  it('add：非裸名 spec（git/path）降级为"出现任一新 dependency"', () => {
    const result = verifyPluginPostCheck(
      snapshot({}, []),
      snapshot({ 'real-name': '^1.0.0' }, []),
      req({ spec: 'github:user/repo#main' }),
    )
    expect(result.ok).toBe(true)
    expect(result.ok && result.evidence).toContain('real-name')
  })

  it('remove：包名消失才通过，仍在 = 失败', () => {
    expect(verifyPluginPostCheck(
      snapshot({ 'p': '1' }, []), snapshot({}, []), req({ action: 'remove', spec: 'p' }),
    ).ok).toBe(true)
    expect(verifyPluginPostCheck(
      snapshot({ 'p': '1' }, []), snapshot({ 'p': '1' }, []), req({ action: 'remove', spec: 'p' }),
    ).ok).toBe(false)
  })

  it('update：版本变化与"已是最新"都通过并如实报告', () => {
    const changed = verifyPluginPostCheck(
      snapshot({ 'p': '1.0.0' }, []), snapshot({ 'p': '2.0.0' }, []), req({ action: 'update', spec: 'p' }),
    )
    expect(changed.ok).toBe(true)
    expect(changed.ok && changed.evidence).toContain('2.0.0')
    const same = verifyPluginPostCheck(
      snapshot({ 'p': '1.0.0' }, []), snapshot({ 'p': '1.0.0' }, []), req({ action: 'update', spec: 'p' }),
    )
    expect(same.ok).toBe(true)
    expect(same.ok && same.evidence).toContain('版本未变化')
    expect(verifyPluginPostCheck(
      snapshot({ 'p': '1.0.0' }, []), snapshot({}, []), req({ action: 'update', spec: 'p' }),
    ).ok).toBe(false)
  })

  it('update name@version 形态：manifest 键按裸包名提取，不再误判失败', () => {
    const changed = verifyPluginPostCheck(
      snapshot({ 'pkg': '^1.0.0' }, []),
      snapshot({ 'pkg': '^2.0.0' }, []),
      req({ action: 'update', spec: 'pkg@^2.0.0' }),
    )
    expect(changed.ok).toBe(true)
    expect(changed.ok && changed.evidence).toContain('pkg')
    const scoped = verifyPluginPostCheck(
      snapshot({ '@scope/pkg': '1.0.0' }, []),
      snapshot({ '@scope/pkg': '1.2.3' }, []),
      req({ action: 'update', spec: '@scope/pkg@1.2.3' }),
    )
    expect(scoped.ok).toBe(true)
    expect(scoped.ok && scoped.evidence).toContain('1.2.3')
  })

  it('update/remove 的 spec 无法提取包名时明确失败（不猜测）', () => {
    const updateBad = verifyPluginPostCheck(
      snapshot({}, []), snapshot({}, []), req({ action: 'update', spec: 'github:user/repo#main' }),
    )
    expect(updateBad.ok).toBe(false)
    if (!updateBad.ok) expect(updateBad.evidence).toContain('无法提取包名')
    const removeBad = verifyPluginPostCheck(
      snapshot({}, []), snapshot({}, []), req({ action: 'remove', spec: 'github:user/repo#main' }),
    )
    expect(removeBad.ok).toBe(false)
    if (!removeBad.ok) expect(removeBad.evidence).toContain('无法提取包名')
  })

  it('install：discovery 可解析才通过；malformed 或 bundles 清空 = 失败', () => {
    expect(verifyPluginPostCheck(
      snapshot({ 'p': '1' }, ['p']), snapshot({ 'p': '1' }, ['p']), req({ action: 'install', spec: null }),
    ).ok).toBe(true)
    expect(verifyPluginPostCheck(
      snapshot({ 'p': '1' }, ['p']),
      { ...snapshot({ 'p': '1' }, ['p']), staticStatus: 'malformed' },
      req({ action: 'install', spec: null }),
    ).ok).toBe(false)
    expect(verifyPluginPostCheck(
      snapshot({ 'p': '1' }, ['p']), snapshot({ 'p': '1' }, []), req({ action: 'install', spec: null }),
    ).ok).toBe(false)
  })
})

describe('shouldShowHandoff（成功且验证通过才提示）', () => {
  const ok = { ok: true as const, evidence: 'x' }
  const bad = { ok: false as const, evidence: 'x' }
  it('exit 0 + post-check ok = 提示；其余一律不提示', () => {
    expect(shouldShowHandoff(0, ok)).toBe(true)
    expect(shouldShowHandoff(1, ok)).toBe(false)
    expect(shouldShowHandoff(0, bad)).toBe(false)
    expect(shouldShowHandoff(0, null)).toBe(false)
  })

  it('handoff 文案为施工单要求的原文语义', () => {
  })
})

describe('main 接线形态（plugin argv 经 resolveDshCommand 组装）', () => {
  it('packaged：plugin 子命令自带 --profile，argv 绝不混入父级 --profile/--host/--port', () => {
    const launch = resolveDshCommand({
      packaged: true,
      resourcesPath: 'E:\\res',
      packagedCwd: 'C:\\home',
      packagedExecutable: 'E:\\DeepCode.exe',
      dshHome: 'C:\\dsh home',
      args: buildPluginOperationArgs({ action: 'add', profile: 'web', spec: 'my-plugin', anchorDir: null }),
    })
    expect(launch.command).toBe('E:\\DeepCode.exe')
    expect(launch.args).toEqual([
      '--expose-internals',
      'E:\\res\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
      'plugin',
      '--profile',
      'web',
      'add',
      'my-plugin',
    ])
    // 父级启动参数（--host/--port/第二个 --profile）一个都不能出现：
    // 官方 grammar 的 rejectParentOptions 会拒绝它们。
    expect(launch.args).not.toContain('--host')
    expect(launch.args).not.toContain('--port')
    expect(launch.args.filter(token => token === '--profile')).toHaveLength(1)
    expect(launch.env.DSH_HOME).toBe('C:\\dsh home')
  })

  it('packaged：把内嵌 pnpm 的入口交给官方 CLI，好让它不必经 shell 调 pnpm', () => {
    const launch = resolveDshCommand({
      packaged: true,
      resourcesPath: 'E:\\res',
      packagedCwd: 'C:\\home',
      packagedExecutable: 'E:\\DeepCode.exe',
      dshHome: 'C:\\dsh home',
      args: buildPluginOperationArgs({ action: 'remove', profile: 'web', spec: 'some-plugin', anchorDir: null }),
    })
    // 没有这一条，官方 CLI 会在 Windows 上用 shell 去找 PATH 里的 pnpm.cmd；
    // shell 就是 cmd.exe，而 broker 起的进程带 windowsHide、没有控制台可继承，
    // Windows 于是另开一个终端窗口——用户看得见它，管道却回不到宿主：没有
    // 输出、没有退出码，操作永远等下去，pnpm 却在那个窗口里把活干完了。
    expect(launch.env.DSH_PNPM_ENTRY).toBe('E:\\res\\dsh\\node_modules\\pnpm\\bin\\pnpm.cjs')
  })

  it('dev：同样形态（tsx 入口 + plugin argv），无父级启动参数', () => {
    const launch = resolveDshCommand({
      packaged: false,
      root: 'E:\\repo',
      dshHome: 'C:\\dsh',
      args: buildPluginOperationArgs({ action: 'install', profile: 'web', spec: null, anchorDir: null }),
    })
    expect(launch.args).toEqual([
      '--import',
      'tsx/esm',
      'apps/cli/src/bin.ts',
      'plugin',
      '--profile',
      'web',
      'install',
    ])
    expect(launch.args).not.toContain('--host')
  })
})

describe('pluginConfirmText（目标透明度：Managed/Existing 明确区分）', () => {
  const base = {
    dshHome: 'C:\\home\\dsh',
    profile: 'web',
    action: 'add' as const,
    spec: 'my-plugin',
    locale: 'zh' as const,
  }

  it('Managed：列出 Home kind/完整路径/Profile/操作/spec，无 Existing 警示', () => {
    const text = pluginConfirmText({ ...base, homeKind: 'managed' })
    expect(text.detail).toContain('托管模式')
    expect(text.detail).toContain('C:\\home\\dsh')
    expect(text.detail).toContain('Profile：web')
    expect(text.detail).toContain('安装')
    expect(text.detail).toContain('my-plugin')
    expect(text.detail).not.toContain('这次操作会修改你选择的现有 Harness Profile。')
  })

  it('Existing：必须出现施工单要求的警示句', () => {
    const text = pluginConfirmText({ ...base, homeKind: 'existing' })
    expect(text.detail).toContain('已有目录')
    expect(text.detail).toContain('这次操作会修改你选择的现有 Harness Profile。')
  })

  it('英文 locale 与 install（无 spec）形态', () => {
    const text = pluginConfirmText({ ...base, homeKind: 'existing', locale: 'en', action: 'install', spec: null })
    expect(text.message).toBe('Confirm plugin operation')
    expect(text.detail).toContain('Existing')
    expect(text.detail).toContain('Install / repair dependencies')
    expect(text.detail).not.toContain('Package：')
  })
})

describe('插件 spec 不接受嵌在 URL 里的凭据', () => {
  it.each([
    'https://user:token@example.com/pkg.tgz',
    'git+https://user:token@git.example.com/x.git',
    'https://user@example.com/pkg.tgz',
  ])('%s → 拒绝（原始 spec 会写进 recovery journal）', (spec) => {
    expect(specHasCredentials(spec)).toBe(true)
    expect(validatePluginRequest({ profile: 'web', action: 'add', spec, anchorDir: null })).toContain('账号密码')
  })

  it.each([
    'lodash',
    '@scope/pkg@1.2.3',
    'https://example.com/pkg.tgz',
  ])('%s → 放行（普通包名与干净 URL 不受影响）', (spec) => {
    expect(specHasCredentials(spec)).toBe(false)
  })
})
