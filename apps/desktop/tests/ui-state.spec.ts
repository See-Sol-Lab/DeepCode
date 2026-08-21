/**
 * ui-state 纯逻辑测试：默认值、严格 schema（未知字段/非法值）、损坏
 * 回退默认不抛错（UI 偏好绝不挡启动）、原子写入、恢复提示标识稳定
 * 与 effectiveTheme 映射。
 * 不涉及 Electron，可在普通 Node 环境下运行。
 * @module @see-sol-lab/deepcode/tests/ui-state
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createUiStateStore,
  defaultUiState,
  effectiveTheme,
  parseUiState,
  recoveryAckKey,
  serializeUiState,
  UI_STATE_FILENAME,
  type DesktopUiStateV1,
} from '../src/ui-state.ts'

let temp: string | undefined

afterEach(() => {
  if (temp !== undefined) rmSync(temp, { recursive: true, force: true })
  temp = undefined
})

/** 新建一个测试临时目录（绝对路径）。 */
function tempDir(): string {
  temp = mkdtempSync(join(tmpdir(), 'dsh-ui-state-'))
  return temp
}

/** 含全部合法字段的样例状态。 */
function sampleState(): DesktopUiStateV1 {
  return {
    schemaVersion: 2,
    windowBounds: { x: 10, y: 20, width: 1280, height: 800 },
    maximized: true,
    themePreference: 'dark',
    acknowledgedRecoveryHash: 'a'.repeat(64),
    expertDetailsExpanded: true,
    closeToTrayNoticeAcknowledged: true,
  }
}

describe('defaultUiState', () => {
  it('默认：无几何、未最大化、跟随系统、无确认、专家详情折叠、未确认托盘说明', () => {
    expect(defaultUiState()).toEqual({
      schemaVersion: 2,
      windowBounds: null,
      maximized: false,
      themePreference: 'system',
      acknowledgedRecoveryHash: null,
      expertDetailsExpanded: false,
      closeToTrayNoticeAcknowledged: false,
    })
  })
})

describe('parseUiState 严格校验', () => {
  it('接受全部合法字段的往返', () => {
    const state = sampleState()
    expect(parseUiState(serializeUiState(state))).toEqual(state)
  })

  const base = '"schemaVersion":2,"windowBounds":null,"maximized":false,"themePreference":"system","acknowledgedRecoveryHash":null,"expertDetailsExpanded":false,"closeToTrayNoticeAcknowledged":false'
  it.each([
    ['非法 JSON', '{oops'],
    ['未知 schema 版本', `{${base}}`.replace('"schemaVersion":2', '"schemaVersion":99')],
    ['越界字段（session 事实）', `{${base},"activeSelection":{"profile":"web"}}`],
    ['越界字段（credential）', `{${base},"apiKey":"sk-x"}`],
    ['未知主题', `{${base}}`.replace('"themePreference":"system"', '"themePreference":"blue"')],
    ['负数宽', `{${base.replace('"windowBounds":null', '"windowBounds":{"x":0,"y":0,"width":-1,"height":10}')}}`],
    ['NaN 坐标', `{${base.replace('"windowBounds":null', '"windowBounds":{"x":null,"y":0,"width":10,"height":10}')}}`],
    ['bounds 含未知字段', `{${base.replace('"windowBounds":null', '"windowBounds":{"x":0,"y":0,"width":10,"height":10,"scale":2}')}}`],
    ['超长确认标识', `{${base.replace('"acknowledgedRecoveryHash":null', '"acknowledgedRecoveryHash":"' + 'b'.repeat(65) + '"')}}`],
    ['maximized 非布尔', `{${base.replace('"maximized":false', '"maximized":"yes"')}}`],
    ['托盘确认非布尔', `{${base.replace('"closeToTrayNoticeAcknowledged":false', '"closeToTrayNoticeAcknowledged":"yes"')}}`],
    ['缺少托盘确认字段', `{${base.replace(',"closeToTrayNoticeAcknowledged":false', '')}}`],
  ])('拒绝 %s', (_name, content) => {
    expect(() => parseUiState(content)).toThrow()
  })
})

describe('createUiStateStore.read 损坏兜底', () => {
  it('文件不存在返回默认且不创建文件', () => {
    const dir = tempDir()
    const store = createUiStateStore(dir)
    expect(store.filePath).toBe(join(dir, UI_STATE_FILENAME))
    expect(store.read()).toEqual({ state: defaultUiState(), error: null })
    expect(existsSync(store.filePath)).toBe(false)
  })

  it('内容损坏返回默认 + 错误说明，绝不抛出（UI 偏好不挡启动）', () => {
    const dir = tempDir()
    const store = createUiStateStore(dir)
    writeFileSync(store.filePath, '{"schemaVersion":99}', 'utf8')
    const result = store.read()
    expect(result.state).toEqual(defaultUiState())
    expect(result.error).not.toBeNull()
  })

  it('有效内容正常读回', () => {
    const dir = tempDir()
    const store = createUiStateStore(dir)
    store.write(sampleState())
    expect(store.read()).toEqual({ state: sampleState(), error: null })
    expect(readFileSync(store.filePath, 'utf8')).toBe(serializeUiState(sampleState()))
  })
})

describe('createUiStateStore.write 原子写', () => {
  it('非法状态写入前被拒绝，不落盘', () => {
    const dir = tempDir()
    const store = createUiStateStore(dir)
    const bad = { ...defaultUiState(), themePreference: 'blue' as never }
    expect(() => { store.write(bad) }).toThrow()
    expect(existsSync(store.filePath)).toBe(false)
  })

  it('spaces/Unicode userData 目录正常读写', () => {
    const dir = join(tempDir(), '深 度 测试 dir')
    mkdirSync(dir, { recursive: true })
    const store = createUiStateStore(dir)
    store.write(sampleState())
    expect(store.read().state).toEqual(sampleState())
  })
})

describe('recoveryAckKey', () => {
  it('同一条提示事实产生同一标识，任何字段变化产生新标识', () => {
    const base = { stage: 'readiness', message: 'm', failedTarget: 'Managed / web', recoveredTo: 'Existing C:\\x / good' }
    const a = recoveryAckKey(base)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(recoveryAckKey(base)).toBe(a)
    expect(recoveryAckKey({ ...base, message: 'm2' })).not.toBe(a)
    expect(recoveryAckKey({ ...base, failedTarget: null })).not.toBe(a)
    expect(recoveryAckKey({ ...base, recoveredTo: 'other' })).not.toBe(a)
  })
})

describe('effectiveTheme', () => {
  it.each([
    ['light', true, 'light'],
    ['light', false, 'light'],
    ['dark', true, 'dark'],
    ['dark', false, 'dark'],
    ['system', true, 'dark'],
    ['system', false, 'light'],
  ] as const)('%s + systemDark=%s → %s', (preference, systemDark, expected) => {
    expect(effectiveTheme(preference, systemDark)).toBe(expected)
  })
})
