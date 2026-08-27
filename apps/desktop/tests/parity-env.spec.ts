/**
 * Parity 隔离环境测试：凭据形态变量（任意大小写）不进入被测环境，
 * APPDATA/LOCALAPPDATA/DSH_HOME 全部落在测试临时根内。
 * @module @see-sol-lab/deepseekgui/tests/parity-env
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parityEnv, scrubCredentialEnv } from '../tests-e2e/parity-env.ts'

let temp: string | undefined

afterEach(() => {
  if (temp !== undefined) rmSync(temp, { recursive: true, force: true })
  temp = undefined
})

describe('scrubCredentialEnv', () => {
  it('剔除任意大小写的 KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL', () => {
    const scrubbed = scrubCredentialEnv({
      DEEPSEEK_API_KEY: 'x',
      openai_api_key: 'x',
      GH_Token: 'x',
      My_Secret_Value: 'x',
      DbPassword: 'x',
      AWS_CREDENTIAL_FILE: 'x',
      PATH: 'C:\\Windows',
      LANG: 'zh-CN',
    })
    expect(Object.keys(scrubbed).sort()).toEqual(['LANG', 'PATH'])
  })
})

describe('parityEnv', () => {
  it('APPDATA/LOCALAPPDATA/DSH_HOME 全部指进测试临时根并已创建', () => {
    temp = mkdtempSync(join(tmpdir(), 'dsh-parity-env-'))
    const env = parityEnv(temp)
    expect(env.APPDATA).toBe(join(temp, 'appdata-roaming'))
    expect(env.LOCALAPPDATA).toBe(join(temp, 'appdata-local'))
    expect(env.DSH_HOME).toBe(join(temp, 'dsh-home'))
    for (const name of ['APPDATA', 'LOCALAPPDATA', 'DSH_HOME']) {
      expect(env[name]!.startsWith(temp)).toBe(true)
    }
    // 真实凭据绝不透传（无论宿主环境有什么）。
    for (const name of Object.keys(env)) {
      expect(/key|token|secret|password|credential/i.test(name)).toBe(false)
    }
  })
})
