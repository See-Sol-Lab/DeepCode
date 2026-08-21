/**
 * Runtime closure computation tests: recursive production deps, optional deps,
 * devDependency exclusion, dynamic Web-profile seeds, and loud failure on
 * missing local runtime dependencies.
 * @module scripts/runtime-closure
 */

import { describe, expect, it } from 'vitest'
import { computeRuntimeClosure, parsePluginNames } from './runtime-closure.ts'

/** One tarball manifest builder. */
function manifest(name: string, dependencies: Record<string, string> = {}, optionalDependencies: Record<string, string> = {}): {
  name: string
  dependencies: Record<string, string>
  optionalDependencies: Record<string, string>
  peerDependencies?: Record<string, string>
} {
  return { name, dependencies, optionalDependencies }
}

function map(entries: ReturnType<typeof manifest>[]): Map<string, ReturnType<typeof manifest>> {
  return new Map(entries.map(entry => [entry.name, entry]))
}

describe('computeRuntimeClosure', () => {
  it('递归计算生产依赖', () => {
    const manifests = map([
      manifest('@deepseek-ai/dsh-a', { '@deepseek-ai/dsh-b': '^1' }),
      manifest('@deepseek-ai/dsh-b', { '@deepseek-ai/dsh-c': '^1' }),
      manifest('@deepseek-ai/dsh-c'),
    ])
    const { included, excluded } = computeRuntimeClosure(manifests, ['@deepseek-ai/dsh-a'])
    expect(included).toEqual(['@deepseek-ai/dsh-a', '@deepseek-ai/dsh-b', '@deepseek-ai/dsh-c'])
    expect(excluded).toEqual([])
  })

  it('optionalDependency 纳入闭包', () => {
    const manifests = map([
      manifest('@deepseek-ai/dsh-a', {}, { '@deepseek-ai/dsh-b': '^1' }),
      manifest('@deepseek-ai/dsh-b'),
    ])
    const { included } = computeRuntimeClosure(manifests, ['@deepseek-ai/dsh-a'])
    expect(included).toContain('@deepseek-ai/dsh-b')
  })

  it('peerDependency 纳入闭包（npm 自动安装 peers，本地 peer 必须随发行提供）', () => {
    const manifests = map([
      manifest('@deepseek-ai/dsh-worker-thread'),
      manifest('@deepseek-ai/dsh-engine'),
      manifest('@deepseek-ai/dsh-other'),
    ])
    manifests.set('@deepseek-ai/dsh-worker-thread', {
      name: '@deepseek-ai/dsh-worker-thread',
      dependencies: {},
      optionalDependencies: {},
      peerDependencies: { '@deepseek-ai/dsh-engine': '^1' },
    })
    const { included, excluded } = computeRuntimeClosure(manifests, ['@deepseek-ai/dsh-worker-thread'])
    expect(included).toContain('@deepseek-ai/dsh-engine')
    expect(excluded).toContain('@deepseek-ai/dsh-other')
    expect(included).not.toContain('@deepseek-ai/dsh-other')
  })

  it('devDependency 被排除', () => {
    const manifests = map([
      manifest('@deepseek-ai/dsh-a', { '@deepseek-ai/dsh-b': '^1' }),
      manifest('@deepseek-ai/dsh-b'),
    ])
    // dsh-b is a production dep; the closure never reads devDependencies, and a
    // test-only package is not reachable.
    const { included } = computeRuntimeClosure(manifests, ['@deepseek-ai/dsh-a'])
    expect(included).toContain('@deepseek-ai/dsh-b')
    // A devDependency-only consumer is simply absent from production edges.
    const testManifests = map([
      manifest('@deepseek-ai/dsh-a', {}, {}),
      manifest('@deepseek-ai/dsh-test-support'),
    ])
    const devClosure = computeRuntimeClosure(testManifests, ['@deepseek-ai/dsh-a'])
    expect(devClosure.excluded).toContain('@deepseek-ai/dsh-test-support')
  })

  it('动态 Web profile seed 被纳入', () => {
    const manifests = map([
      manifest('@deepseek-ai/dsh-web-frontend', { react: '^18' }),
      manifest('@deepseek-ai/dsh-other'),
    ])
    // dsh-web-frontend is the dynamic require.resolve target of dsh-web-app
    // (frontend dist), invisible in static dependency edges.
    const { included } = computeRuntimeClosure(manifests, ['@deepseek-ai/dsh-web-frontend'])
    expect(included).toContain('@deepseek-ai/dsh-web-frontend')
    expect(included).not.toContain('@deepseek-ai/dsh-other')
  })

  it('缺失的本地运行依赖明确失败', () => {
    const manifests = map([manifest('@deepseek-ai/dsh-a')])
    expect(() => computeRuntimeClosure(manifests, ['@deepseek-ai/dsh-missing']))
      .toThrow(/absent from the tarballs: @deepseek-ai\/dsh-missing/)
  })

  it('递归可达的本地依赖缺 tarball 也明确失败（不被当外部依赖忽略）', () => {
    const manifests = map([
      manifest('@deepseek-ai/dsh-a', { '@deepseek-ai/dsh-b': '^1' }),
      manifest('@deepseek-ai/dsh-b', { '@deepseek-ai/dsh-unpacked': '^1' }),
    ])
    expect(() => computeRuntimeClosure(manifests, ['@deepseek-ai/dsh-a']))
      .toThrow(/local runtime dependencies absent from the tarballs: @deepseek-ai\/dsh-unpacked \(required by @deepseek-ai\/dsh-b\)/)
  })

  it('缺 tarball 的本地 optional/peer 依赖同样明确失败', () => {
    const optional = map([manifest('@deepseek-ai/dsh-a', {}, { '@deepseek-ai/dsh-gone': '^1' })])
    expect(() => computeRuntimeClosure(optional, ['@deepseek-ai/dsh-a']))
      .toThrow(/@deepseek-ai\/dsh-gone/)
    const peers = map([manifest('@deepseek-ai/dsh-a')])
    peers.set('@deepseek-ai/dsh-a', {
      name: '@deepseek-ai/dsh-a',
      dependencies: {},
      optionalDependencies: {},
      peerDependencies: { '@deepseek-ai/dsh-gone': '^1' },
    })
    expect(() => computeRuntimeClosure(peers, ['@deepseek-ai/dsh-a']))
      .toThrow(/@deepseek-ai\/dsh-gone/)
  })

  it('外部 npm 依赖不被误判为本地缺失', () => {
    const manifests = map([
      manifest('@deepseek-ai/dsh-a', { 'commander': '^12', 'js-yaml': '^4', '@opentelemetry/api': '^1' }),
    ])
    const { included } = computeRuntimeClosure(manifests, ['@deepseek-ai/dsh-a'])
    expect(included).toEqual(['@deepseek-ai/dsh-a'])
  })

  it('registryExternal 点名的本仓库 scope 包按外部依赖处理（如 Landlock 启动器家族）', () => {
    const manifests = map([
      manifest('@deepseek-ai/dsh-sandbox-local', { '@deepseek-ai/node-addon-landlock-run': '^1' }),
    ])
    // 未点名时按漏打 tarball 报错。
    expect(() => computeRuntimeClosure(manifests, ['@deepseek-ai/dsh-sandbox-local']))
      .toThrow(/node-addon-landlock-run/)
    // 点名后视为 registry 解析的外部包，不纳入也不报错。
    const { included } = computeRuntimeClosure(
      manifests,
      ['@deepseek-ai/dsh-sandbox-local'],
      new Set(['@deepseek-ai/node-addon-landlock-run']),
    )
    expect(included).toEqual(['@deepseek-ai/dsh-sandbox-local'])
  })

  it('optional peer 被保守纳入（封闭发行无法事后安装；npm 本身不会自动装 optional peer）', () => {
    const manifests = map([
      manifest('@deepseek-ai/dsh-consumer'),
      manifest('@deepseek-ai/dsh-optional-peer'),
    ])
    manifests.set('@deepseek-ai/dsh-consumer', {
      name: '@deepseek-ai/dsh-consumer',
      dependencies: {},
      optionalDependencies: {},
      peerDependencies: { '@deepseek-ai/dsh-optional-peer': '^1' },
    })
    // peerDependenciesMeta is not read: the closure includes every local peer,
    // optional or not, which is a superset of npm's install behavior.
    const { included } = computeRuntimeClosure(manifests, ['@deepseek-ai/dsh-consumer'])
    expect(included).toContain('@deepseek-ai/dsh-optional-peer')
  })

  it('排除清单包含所有不可达 tarball', () => {
    const manifests = map([
      manifest('@deepseek-ai/dsh-a'),
      manifest('@deepseek-ai/dsh-b'),
      manifest('@deepseek-ai/dsh-c'),
    ])
    const { included, excluded } = computeRuntimeClosure(manifests, ['@deepseek-ai/dsh-a'])
    expect(included).toEqual(['@deepseek-ai/dsh-a'])
    expect(excluded).toEqual(['@deepseek-ai/dsh-b', '@deepseek-ai/dsh-c'])
  })
})

describe('parsePluginNames', () => {
  it('收集顶层与 insert 行的插件名', () => {
    const yaml = `
- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
- insert:
    - id: session
      name: '@deepseek-ai/dsh-session'
    - id: group
      name: cordis:group
      config:
        - id: plan-mode
          name: '@deepseek-ai/dsh-plan-mode'
`
    expect(parsePluginNames(yaml).sort()).toEqual([
      '@deepseek-ai/cordis-plugin-timer',
      '@deepseek-ai/dsh-plan-mode',
      '@deepseek-ai/dsh-session',
    ])
  })

  it('子路径引用归约到所属包', () => {
    const yaml = `
- id: list-agents
  name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
- id: startup
  name: '@deepseek-ai/dsh-web-app/startup'
`
    expect(parsePluginNames(yaml).sort()).toEqual([
      '@deepseek-ai/dsh-tool-subagent-control',
      '@deepseek-ai/dsh-web-app',
    ])
  })

  it('忽略 cordis:group 与无 name 的行', () => {
    const yaml = `
- id: tools
  config:
    mode: native
- id: group
  name: cordis:group
`
    expect(parsePluginNames(yaml)).toEqual([])
  })
})
