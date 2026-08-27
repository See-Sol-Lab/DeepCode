/**
 * 发行构建入口的 freshness 门禁：公开的 `build:desktop-dist` 必须先从
 * 当前源码重建全部输入（lib:host、web、desktop），再进入内部 assemble；
 * 否则会重演"源码已改、包里还是旧 lib"的事故。
 * @module @see-sol-lab/deepseekgui/tests/build-scripts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../src/dsh-service.ts'

const scripts = (JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}).scripts

describe('build:desktop-dist freshness 链', () => {
  it('公开入口按序重建当前源码的全部输入后才 assemble', () => {
    const command = scripts['build:desktop-dist']
    expect(command).toBeDefined()
    // build:lib（host+client 全编——只编 host 曾让 D25 的 client CSS 改动
    // 从未进包，2026-08-23 实机灾难）→ 品牌化 web 构建（P8-D34：
    // DSH_CLIENT_BRAND_* 经 build-web-branded.ts 注入）→ desktop → assemble。
    const stages = ['build:lib', 'build-web-branded.ts', 'build:desktop', 'build:desktop-dist:assemble']
    const positions = stages.map(stage => (command ?? '').indexOf(stage))
    for (const [index, position] of positions.entries()) {
      expect(position, `缺少阶段 ${stages[index] ?? ''}`).toBeGreaterThanOrEqual(0)
    }
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    // 公开入口不得绕过重建直接调用 assemble 脚本文件。
    expect(command).not.toContain('scripts/build-desktop-dist.ts')
    // 只编 host 的旧前置绝不允许回归。
    expect(command).not.toContain('build:lib:host')
  })

  it('内部 assemble 步骤才直接运行 build-desktop-dist 脚本', () => {
    expect(scripts['build:desktop-dist:assemble']).toBe('tsx scripts/build-desktop-dist.ts')
  })
})
