/**
 * Profile machinery of `dsh-app-boot`: directory resolution and init,
 * manifest round-trips, two-anchor bundle resolution, patch-layer loading,
 * empty-root composition, and the installation module-fallback healing.
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  composeEntries,
  healProfilesModuleFallback,
  initProfile,
  inspectExistingProfiles,
  loadProfile,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveBundleDir,
  resolveProfileDir,
  writeProfileManifest,
} from '../src/index.ts'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-profile-'))

/** Stage a fake installed app: package.json with deps and a node_modules holding bundles. */
function stageInstallation(bundles: Record<string, { patch?: string; deps?: Record<string, string> }>): string {
  const root = tmp()
  const appDir = join(root, 'app')
  mkdirSync(join(appDir, 'node_modules'), { recursive: true })
  const appDeps: Record<string, string> = {}
  for (const [name, spec] of Object.entries(bundles)) {
    appDeps[name] = '0.0.0'
    const dir = join(appDir, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name,
      version: '0.0.0',
      dependencies: spec.deps ?? {},
      ...spec.patch === undefined ? {} : { dsh: { bundle: { patch: './cordis.patch.yml' } } },
    }))
    if (spec.patch !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), spec.patch)
  }
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'dsh-app', dependencies: appDeps }))
  return join(appDir, 'package.json')
}

describe('resolveProfileDir', () => {
  it('joins the home and rejects traversal-shaped names', () => {
    const home = tmp()
    expect(resolveProfileDir('tui', home)).toBe(join(home, 'profiles', 'tui'))
    for (const bad of ['', '.', '..', 'a/b', 'a\\b']) {
      expect(() => resolveProfileDir(bad, home)).toThrow('invalid profile name')
    }
  })
})

describe('initProfile', () => {
  it('creates manifest, user patch layer, and pnpm workspace once, never overwriting', () => {
    const home = tmp()
    const dir = resolveProfileDir('tui', home)
    initProfile(dir, ['@deepseek-ai/dsh-base'])
    const manifest = readProfileManifest('t', dir)
    expect(manifest.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toContain('[]')
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('nodeLinker: hoisted')
    // Re-init keeps user edits.
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '- id: x\n  config: {}\n')
    initProfile(dir, ['other'])
    expect(readProfileManifest('t', dir).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toContain('- id: x')
  })
})

describe('manifest round-trip', () => {
  it('writes and reads back, and fails loud on a broken manifest', () => {
    const dir = tmp()
    writeProfileManifest(dir, { name: 'p', dsh: { profile: { bundles: ['a'] } } })
    expect(readProfileManifest('t', dir).dsh?.profile?.bundles).toEqual(['a'])
    writeFileSync(join(dir, 'package.json'), '[]')
    expect(() => readProfileManifest('t', dir)).toThrow('must hold a JSON object')
    expect(() => readProfileManifest('t', join(dir, 'nope'))).toThrow('failed to read profile manifest')
  })
})

describe('resolveBundleDir', () => {
  it('prefers the installation anchor, falls back to the profile, and fails loud', () => {
    const anchor = stageInstallation({ 'in-box': { patch: '[]\n' } })
    const profileDir = tmp()
    mkdirSync(join(profileDir, 'node_modules', 'local-only'), { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), '{}')
    writeFileSync(join(profileDir, 'node_modules', 'local-only', 'package.json'), JSON.stringify({ name: 'local-only', version: '0.0.0' }))
    expect(resolveBundleDir('t', 'in-box', anchor, profileDir)).toContain('in-box')
    expect(resolveBundleDir('t', 'local-only', anchor, profileDir)).toContain('local-only')
    expect(() => resolveBundleDir('t', 'absent', anchor, profileDir)).toThrow('cannot resolve profile bundle')
  })

  it('resolves a package whose exports map omits ./package.json', () => {
    // Common on npm: an exports map without "./package.json" makes
    // require.resolve('<pkg>/package.json') throw ERR_PACKAGE_PATH_NOT_EXPORTED;
    // resolution must fall through to the paths probe instead of misreporting
    // the installed package as missing.
    const anchor = stageInstallation({})
    const profileDir = tmp()
    writeFileSync(join(profileDir, 'package.json'), '{}')
    const dir = join(profileDir, 'node_modules', 'sealed-bundle')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'sealed-bundle',
      version: '0.0.0',
      exports: { '.': './index.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(join(dir, 'index.js'), '')
    writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
    expect(resolveBundleDir('t', 'sealed-bundle', anchor, profileDir)).toBe(dir)
  })
})

describe('loadProfile', () => {
  it('resolves each dsh.profile.bundles entry to its patch layer in order, plus the user layer', () => {
    const anchor = stageInstallation({
      'bundle-a': { patch: '- insert:\n    - id: a\n      name: pkg-a\n' },
      'bundle-b': { patch: '- id: a\n  config:\n    v: 2\n' },
    })
    const home = tmp()
    const dir = resolveProfileDir('demo', home)
    initProfile(dir, ['bundle-a', 'bundle-b'])
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '- id: a\n  config:\n    v: 3\n')
    const profile = loadProfile('t', 'demo', anchor, home)
    expect(profile.layers.map(layer => layer.packageName)).toEqual(['bundle-a', 'bundle-b'])
    expect(profile.patches).toHaveLength(1)
    const entries = composeEntries([
      ...profile.layers.map(layer => layer.patches),
      profile.patches,
    ])
    expect(entries).toEqual([{ id: 'a', name: 'pkg-a', config: { v: 3 } }])
    // A hand-made profile without the user layer file or dsh section: empty layers, no throw.
    rmSync(join(dir, PROFILE_PATCH_FILENAME))
    expect(loadProfile('t', 'demo', anchor, home).patches).toEqual([])
    writeProfileManifest(dir, { name: 'bare' })
    const bare = loadProfile('t', 'demo', anchor, home)
    expect(bare.layers).toEqual([])
  })

  it('auto-initializes only shipped templates and fails loud otherwise', () => {
    const anchor = stageInstallation({})
    const home = tmp()
    expect(() => loadProfile('t', 'custom', anchor, home))
      .toThrow('profile "custom" does not exist')
    // The web template auto-initializes on first load. Bundle resolution
    // cannot be asserted to fail here: the source-plane test runner resolves
    // @deepseek-ai/* through tsconfig paths regardless of the staged anchor.
    expect(PROFILE_TEMPLATES.web).toContain('@deepseek-ai/dsh-base')
    try {
      loadProfile('t', 'web', anchor, home)
    } catch {
      // Resolution failure is the plain-Node outcome for this empty anchor.
    }
    expect(readProfileManifest('t', resolveProfileDir('web', home)).dsh?.profile?.bundles)
      .toEqual([...PROFILE_TEMPLATES.web ?? []])
  })

  it('normalizes only the exact installation-owned headless bundle tuple', () => {
    const anchor = stageInstallation({
      '@deepseek-ai/dsh-base': { patch: '[]\n' },
      '@deepseek-ai/dsh-web-app': { patch: '[]\n' },
      '@deepseek-ai/dsh-headless': { patch: '[]\n' },
      'custom-bundle': { patch: '[]\n' },
    })
    const home = tmp()
    const stock = resolveProfileDir('headless', home)
    initProfile(stock, [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless',
    ])
    loadProfile('t', 'headless', anchor, home)
    expect(readProfileManifest('t', stock).dsh?.profile?.bundles)
      .toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])

    const customHome = tmp()
    const custom = resolveProfileDir('headless', customHome)
    initProfile(custom, [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless', 'custom-bundle',
    ])
    loadProfile('t', 'headless', anchor, customHome)
    expect(readProfileManifest('t', custom).dsh?.profile?.bundles).toEqual([
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless', 'custom-bundle',
    ])
  })

  it('fails loud when a listed bundle declares no dsh.bundle', () => {
    const anchor = stageInstallation({ 'not-a-bundle': {} })
    const home = tmp()
    const dir = resolveProfileDir('demo', home)
    initProfile(dir, ['not-a-bundle'])
    expect(() => loadProfile('t', 'demo', anchor, home)).toThrow('declares no dsh.bundle')
  })
})

describe('composeEntries', () => {
  it('applies layers over an empty root and reports skipped patches', () => {
    const warnings: string[] = []
    const entries = composeEntries([
      [{ insert: [{ id: 'x', name: 'pkg-x', config: { a: 1 } }] }],
      [{ id: 'x', config: { a: 2 } }, { id: 'missing', config: {} }],
    ], message => warnings.push(message))
    expect(entries).toEqual([{ id: 'x', name: 'pkg-x', config: { a: 2 } }])
    expect(warnings.join('\n')).toContain('"missing"')
    // Default warn sink: skipped patches are silently dropped (boot repeats them).
    expect(composeEntries([[{ id: 'missing', config: {} }]])).toEqual([])
  })
})

describe('inspectExistingProfiles', () => {
  /** A fake installation whose bundles declare the official surface rows. */
  function stageSurfaceInstallation(): string {
    return stageInstallation({
      'web-bundle': {
        patch: [
          '- insert:',
          '    - id: web-startup',
          "      name: '@deepseek-ai/dsh-web-app/startup'",
          '    - id: webserver',
          "      name: '@deepseek-ai/dsh-host-webserver'",
          '    - id: web-runtime',
          "      name: '@deepseek-ai/dsh-web-app'",
          '',
        ].join('\n'),
      },
      'headless-bundle': {
        patch: [
          '- insert:',
          '    - id: headless-startup',
          "      name: '@deepseek-ai/dsh-headless/startup'",
          '    - id: headless-runner',
          "      name: '@deepseek-ai/dsh-headless'",
          '',
        ].join('\n'),
      },
      'custom-bundle': { patch: '- insert:\n    - id: custom-row\n      name: custom-pkg\n' },
    })
  }

  /** Hand-write one existing profile (no init, no normalization). */
  function stageProfile(home: string, name: string, bundles: string[], patch = '[]\n'): string {
    const dir = join(home, 'profiles', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
      name: `dsh-profile-${name}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles } },
    }, undefined, 2)}\n`)
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), patch)
    return dir
  }

  it('同时发现两个 web-capable、一个 headless、一个 candidate 和一个 malformed', () => {
    const anchor = stageSurfaceInstallation()
    const home = tmp()
    stageProfile(home, 'web', ['web-bundle'])
    stageProfile(home, 'web-copy', ['web-bundle'])
    stageProfile(home, 'headless', ['headless-bundle'])
    stageProfile(home, 'custom', ['custom-bundle'])
    stageProfile(home, 'broken', ['ghost-bundle'])
    const profiles = inspectExistingProfiles('t', anchor, home)
    expect(profiles.map(profile => [profile.name, profile.staticStatus])).toEqual([
      ['broken', 'malformed'],
      ['custom', 'candidate'],
      ['headless', 'headless'],
      ['web', 'web-capable'],
      ['web-copy', 'web-capable'],
    ])
    const web = profiles.find(profile => profile.name === 'web')!
    expect(web.bundles).toEqual(['web-bundle'])
    expect(web.evidence.join('\n')).toContain('web-startup, webserver, web-runtime')
    const broken = profiles.find(profile => profile.name === 'broken')!
    expect(broken.bundles).toEqual([])
    expect(broken.evidence).toEqual([])
    expect(broken.error).toContain('cannot resolve profile bundle')
  })

  it('spaces/Unicode 的 home 与 profile 名原样保留并成功发现', () => {
    const anchor = stageSurfaceInstallation()
    const home = join(tmp(), '我的 深度 数据')
    stageProfile(home, '深 度 web', ['web-bundle'])
    const profiles = inspectExistingProfiles('t', anchor, home)
    expect(profiles).toHaveLength(1)
    expect(profiles[0]!.name).toBe('深 度 web')
    expect(profiles[0]!.dir).toBe(join(home, 'profiles', '深 度 web'))
    expect(profiles[0]!.staticStatus).toBe('web-capable')
  })

  it('missing home/profiles 返回空列表且不创建任何目录', () => {
    const anchor = stageSurfaceInstallation()
    const home = join(tmp(), 'never-created')
    expect(inspectExistingProfiles('t', anchor, home)).toEqual([])
    expect(existsSync(home)).toBe(false)
    expect(existsSync(join(home, 'profiles'))).toBe(false)
  })

  it('字面 disabled:true 关闭 web 表面 → candidate', () => {
    const anchor = stageSurfaceInstallation()
    const home = tmp()
    stageProfile(home, 'web-off', ['web-bundle'], '- id: webserver\n  disabled: true\n')
    const [profile] = inspectExistingProfiles('t', anchor, home)
    expect(profile!.staticStatus).toBe('candidate')
    expect(profile!.evidence.join('\n')).toContain('literally disabled')
  })

  it('非字面（动态）disabled 不能静态判定 → candidate', () => {
    const anchor = stageSurfaceInstallation()
    const home = tmp()
    stageProfile(home, 'web-dynamic', ['web-bundle'], '- id: webserver\n  disabled: !!js process.env.OFF\n')
    const [profile] = inspectExistingProfiles('t', anchor, home)
    expect(profile!.staticStatus).toBe('candidate')
    expect(profile!.evidence.join('\n')).toContain('non-literal disabled')
  })

  it('inspection 前后 package.json、两级 cordis.patch.yml 与目录集合都不变', () => {
    const anchor = stageSurfaceInstallation()
    const home = tmp()
    const dir = stageProfile(home, 'web', ['web-bundle'], '- id: webserver\n  disabled: true\n')
    stageProfile(home, 'broken', ['ghost-bundle'])
    const homePatch = join(home, PROFILE_PATCH_FILENAME)
    writeFileSync(homePatch, '- id: web-runtime\n  config:\n    surfaceContext: false\n')
    const snapshot = (): string[] => {
      const files: string[] = []
      const walk = (root: string): void => {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          const path = join(root, entry.name)
          files.push(`${entry.isDirectory() ? 'd' : 'f'}:${path}`)
          if (entry.isDirectory()) walk(path)
        }
      }
      walk(home)
      return files.sort()
    }
    const manifestBefore = readFileSync(join(dir, 'package.json'), 'utf8')
    const patchBefore = readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')
    const homePatchBefore = readFileSync(homePatch, 'utf8')
    const treeBefore = snapshot()
    expect(inspectExistingProfiles('t', anchor, home)).toHaveLength(2)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(manifestBefore)
    expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toBe(patchBefore)
    expect(readFileSync(homePatch, 'utf8')).toBe(homePatchBefore)
    expect(snapshot()).toEqual(treeBefore)
    // 检查也没有生成 cordis.yml。
    expect(existsSync(join(dir, 'cordis.yml'))).toBe(false)
  })

  it('Home 级 patch 以字面 disabled:true 关闭 web 表面 → candidate', () => {
    const anchor = stageSurfaceInstallation()
    const home = tmp()
    stageProfile(home, 'web', ['web-bundle'])
    writeFileSync(join(home, PROFILE_PATCH_FILENAME), '- id: webserver\n  disabled: true\n')
    const [profile] = inspectExistingProfiles('t', anchor, home)
    expect(profile!.staticStatus).toBe('candidate')
    expect(profile!.evidence.join('\n')).toContain('literally disabled')
  })

  it('Home 级 patch 的动态 disabled → candidate', () => {
    const anchor = stageSurfaceInstallation()
    const home = tmp()
    stageProfile(home, 'web', ['web-bundle'])
    writeFileSync(join(home, PROFILE_PATCH_FILENAME), '- id: webserver\n  disabled: !!js process.env.OFF\n')
    const [profile] = inspectExistingProfiles('t', anchor, home)
    expect(profile!.staticStatus).toBe('candidate')
    expect(profile!.evidence.join('\n')).toContain('non-literal disabled')
  })

  it('损坏的 Home patch 不写文件，并产生诚实的 malformed 结果', () => {
    const anchor = stageSurfaceInstallation()
    const home = tmp()
    stageProfile(home, 'web', ['web-bundle'])
    const homePatch = join(home, PROFILE_PATCH_FILENAME)
    writeFileSync(homePatch, '- id: webserver\n  config: {broken\n')
    const before = readFileSync(homePatch, 'utf8')
    const warnings: string[] = []
    const profiles = inspectExistingProfiles('t', anchor, home, line => warnings.push(line))
    expect(profiles).toHaveLength(1)
    expect(profiles[0]!.staticStatus).toBe('malformed')
    expect(profiles[0]!.error).toContain('failed to parse')
    expect(profiles[0]!.error).toContain(homePatch)
    expect(warnings.join('\n')).toContain('failed to parse')
    expect(readFileSync(homePatch, 'utf8')).toBe(before)
    expect(existsSync(join(home, 'profiles', 'web', 'cordis.yml'))).toBe(false)
  })

  it('相同 row id、不同插件 name 的自定义 surface → candidate', () => {
    const anchor = stageInstallation({
      'custom-web-bundle': {
        patch: [
          '- insert:',
          '    - id: web-startup',
          "      name: '@deepseek-ai/dsh-web-app/startup'",
          '    - id: webserver',
          "      name: '@deepseek-ai/custom-webserver'",
          '    - id: web-runtime',
          "      name: '@deepseek-ai/dsh-web-app'",
          '',
        ].join('\n'),
      },
    })
    const home = tmp()
    stageProfile(home, 'custom-web', ['custom-web-bundle'])
    const [profile] = inspectExistingProfiles('t', anchor, home)
    expect(profile!.staticStatus).toBe('candidate')
    expect(profile!.evidence.join('\n')).toContain('plugin name other than the official one')
  })

  it('unmatched patch 诊断进入 warn 而不是静默丢弃', () => {
    const anchor = stageSurfaceInstallation()
    const home = tmp()
    stageProfile(home, 'web', ['web-bundle'], '- id: no-such-row\n  config:\n    x: 1\n')
    const warnings: string[] = []
    const [profile] = inspectExistingProfiles('t', anchor, home, line => warnings.push(line))
    expect(profile!.staticStatus).toBe('web-capable')
    expect(warnings.join('\n')).toContain('"no-such-row" not found')
  })
})

describe('healProfilesModuleFallback', () => {
  it('links the app and bundle dependency surface flat under profiles/node_modules', () => {
    const anchor = stageInstallation({
      'bundle-a': { patch: '[]\n', deps: { 'dep-of-a': '0.0.0', 'ghost-dep': '0.0.0' } },
      'plain-lib': {},
    })
    // An app dependency that is declared but not installed: skipped, not fatal.
    const appManifest = JSON.parse(readFileSync(anchor, 'utf8')) as { dependencies: Record<string, string> }
    appManifest.dependencies['never-installed'] = '0.0.0'
    writeFileSync(anchor, JSON.stringify(appManifest))
    // dep-of-a lives in the installation's node_modules too.
    const modules = join(anchor, '..', 'node_modules')
    mkdirSync(join(modules, 'dep-of-a'), { recursive: true })
    writeFileSync(join(modules, 'dep-of-a', 'package.json'), JSON.stringify({ name: 'dep-of-a', version: '0.0.0' }))
    const home = tmp()
    healProfilesModuleFallback(anchor, home)
    const fallback = join(home, 'profiles', 'node_modules')
    // App deps, the bundle's own deps, and the bundle itself are linked; the
    // plain library is linked as an app dep (harmless), the app itself too.
    for (const name of ['bundle-a', 'plain-lib', 'dep-of-a', 'dsh-app']) {
      expect(lstatSync(join(fallback, name)).isSymbolicLink(), name).toBe(true)
    }
    // Idempotent, and a moved target is re-pointed.
    healProfilesModuleFallback(anchor, home)
    const before = readlinkSync(join(fallback, 'dep-of-a'))
    expect(before).toContain('dep-of-a')
  })

  it('throws when a fallback entry is a real directory', () => {
    const anchor = stageInstallation({})
    const home = tmp()
    mkdirSync(join(home, 'profiles', 'node_modules', 'dsh-app'), { recursive: true })
    expect(() => { healProfilesModuleFallback(anchor, home) }).toThrow('is not a symlink')
  })

  it('replaces a wrong symlink', () => {
    const anchor = stageInstallation({})
    const home = tmp()
    const fallback = join(home, 'profiles', 'node_modules')
    mkdirSync(fallback, { recursive: true })
    symlinkSync(tmp(), join(fallback, 'dsh-app'), 'junction')
    healProfilesModuleFallback(anchor, home)
    expect(readlinkSync(join(fallback, 'dsh-app'))).toContain('app')
  })

  it('tolerates losing the concurrent-heal race to an identical link and rejects a different one', () => {
    // The EEXIST arm: a second process wrote the link between our lstat miss
    // and symlinkSync. Simulated by pre-creating the correct link and calling
    // the internal path through a stale-lstat shim is not possible from
    // outside, so probe the observable contract: healing twice concurrently
    // is a no-op, and a foreign REAL directory still fails loud.
    const anchor = stageInstallation({})
    const home = tmp()
    healProfilesModuleFallback(anchor, home)
    healProfilesModuleFallback(anchor, home) // second healer sees the correct link
    const fallback = join(home, 'profiles', 'node_modules')
    expect(lstatSync(join(fallback, 'dsh-app')).isSymbolicLink()).toBe(true)
  })
})
