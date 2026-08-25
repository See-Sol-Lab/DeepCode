/**
 * Embedded-pane bridge parsing (B3-11): the env contract between the DeepCode
 * shell and the plugin. Loopback-only by construction — anything else refuses.
 * @module @see-sol-lab/deepcode-browser/tests/pane
 */

import { describe, expect, it } from 'vitest'
import { paneBridgeFromEnv } from '../../browser-plugin/src/pane.ts'

describe('paneBridgeFromEnv（DEEPCODE_BROWSER_BRIDGE 解析）', () => {
  it('合法值：127.0.0.1:port#token → origin + token', () => {
    expect(paneBridgeFromEnv({ DEEPCODE_BROWSER_BRIDGE: '127.0.0.1:52341#abc-def' }))
      .toEqual({ origin: 'http://127.0.0.1:52341', token: 'abc-def' })
  })

  it('缺失/空值 → null（DeepCode 外正常降级独立 Edge）', () => {
    expect(paneBridgeFromEnv({})).toBeNull()
    expect(paneBridgeFromEnv({ DEEPCODE_BROWSER_BRIDGE: '' })).toBeNull()
  })

  it('坏格式 → null：无 #、# 在开头/结尾', () => {
    expect(paneBridgeFromEnv({ DEEPCODE_BROWSER_BRIDGE: '127.0.0.1:1234' })).toBeNull()
    expect(paneBridgeFromEnv({ DEEPCODE_BROWSER_BRIDGE: '#token' })).toBeNull()
    expect(paneBridgeFromEnv({ DEEPCODE_BROWSER_BRIDGE: '127.0.0.1:1234#' })).toBeNull()
  })

  it('非 loopback 主机一律拒绝（桥永远不该指向远端）', () => {
    expect(paneBridgeFromEnv({ DEEPCODE_BROWSER_BRIDGE: 'evil.example:80#t' })).toBeNull()
    expect(paneBridgeFromEnv({ DEEPCODE_BROWSER_BRIDGE: '192.168.1.5:8080#t' })).toBeNull()
    expect(paneBridgeFromEnv({ DEEPCODE_BROWSER_BRIDGE: 'localhost:8080#t' })).toBeNull()
  })
})
