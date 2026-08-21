/**
 * 共享脱敏规则测试：整段 redactSecrets 的每个凭据形态，以及流式
 * createStreamingRedactor 的核心不变式——任意切分下输出拼接与整段
 * 脱敏完全一致，凭据绝不因 chunk 边界泄漏，正常文本绝不丢失。
 * 所有凭据均为构造的假数据。
 * @module @see-sol-lab/deepcode/tests/redact
 */

import { describe, expect, it } from 'vitest'
import { createStreamingRedactor, redactSecrets, redactUserContext } from '../src/redact.ts'

/** 每个受支持凭据形态的假样本与期望的脱敏标记。 */
const FAKE_SECRETS: readonly { name: string; secret: string; marker: string }[] = [
  { name: 'OpenAI 风格 sk-', secret: 'sk-FAKEfake1234567890abcdef', marker: 'sk-<redacted>' },
  { name: 'GitHub ghp_', secret: `ghp_${'Fake1234'.repeat(4)}`, marker: 'gh*_<redacted>' },
  { name: 'GitHub gho_', secret: `gho_${'Fake1234'.repeat(4)}`, marker: 'gh*_<redacted>' },
  { name: 'GitHub ghu_', secret: `ghu_${'Fake1234'.repeat(4)}`, marker: 'gh*_<redacted>' },
  { name: 'GitHub ghs_', secret: `ghs_${'Fake1234'.repeat(4)}`, marker: 'gh*_<redacted>' },
  { name: 'GitHub ghr_', secret: `ghr_${'Fake1234'.repeat(4)}`, marker: 'gh*_<redacted>' },
  { name: 'Slack xox*-', secret: 'xoxb-1234-fakefake-abcd', marker: 'xox*-<redacted>' },
  { name: 'AWS AKIA', secret: 'AKIAFAKEFAKE12345678', marker: 'AKIA<redacted>' },
  { name: 'Bearer', secret: 'Bearer fake.token~1234/abc=', marker: 'Bearer <redacted>' },
]

/** 把 text 按给定切分点序列喂给一个新的流式脱敏器，返回输出拼接。 */
function streamThrough(text: string, splits: number[]): string {
  const redactor = createStreamingRedactor()
  let out = ''
  let last = 0
  for (const split of [...splits, text.length]) {
    out += redactor.push(text.slice(last, split))
    last = split
  }
  return out + redactor.flush()
}

describe('redactSecrets（整段）', () => {
  it.each(FAKE_SECRETS)('$name 被脱敏', ({ secret, marker }) => {
    const redacted = redactSecrets(`before ${secret} after`)
    expect(redacted).toContain(marker)
    expect(redacted).not.toContain(secret)
    expect(redacted).toContain('before ')
    expect(redacted).toContain(' after')
  })
})

describe('createStreamingRedactor', () => {
  it.each(FAKE_SECRETS)('$name：任意两块切分都不泄漏且与整段一致', ({ secret }) => {
    const whole = `line start ${secret} line end\n`
    const expected = redactSecrets(whole)
    for (let split = 0; split <= whole.length; split += 1) {
      const out = streamThrough(whole, [split])
      expect(out, `split at ${split}`).toBe(expected)
      expect(out, `split at ${split}`).not.toContain(secret)
    }
  })

  it.each(FAKE_SECRETS)('$name：三块切分（前缀/body 双处拆开）同样不泄漏', ({ secret }) => {
    const whole = `a ${secret} z`
    const expected = redactSecrets(whole)
    for (let first = 0; first <= whole.length; first += 3) {
      for (let second = first; second <= whole.length; second += 3) {
        expect(streamThrough(whole, [first, second]), `splits ${first},${second}`).toBe(expected)
      }
    }
  })

  it('同一行多个不同形态的凭据全部脱敏，前后文原样保留', () => {
    const whole = `auth=${FAKE_SECRETS[0]?.secret ?? ''} github=${FAKE_SECRETS[1]?.secret ?? ''} aws=${FAKE_SECRETS[7]?.secret ?? ''} done\n`
    const expected = redactSecrets(whole)
    for (const splits of [[5], [10, 20], [1, 2], [whole.length - 3]]) {
      expect(streamThrough(whole, splits)).toBe(expected)
    }
    expect(expected).toContain('done')
  })

  it('凭据在 chunk 尾部已达最短合法长度、下一块继续 body：续写部分不泄漏', () => {
    // 第一块以完整合法的最短 sk- 匹配结尾，第二块继续 body：过早替换
    // 会让第二块的 body 原样落盘。
    const head = 'key: sk-abcdefgh'
    const tail = `${'LEAKLEAK'.repeat(3)} rest`
    const expected = redactSecrets(head + tail)
    const out = streamThrough(head + tail, [head.length])
    expect(out).toBe(expected)
    expect(out).not.toContain('LEAKLEAK')
    expect(out).toContain('rest')
  })

  it('普通文本（含形似前缀的词与单独的 Bearer 字样）不丢失、不误改', () => {
    const whole = 'task done; Bearer of news; risk-free, ghost mode, xo hugs, AK done\n'
    expect(redactSecrets(whole)).toBe(whole)
    for (let split = 0; split <= whole.length; split += 1) {
      expect(streamThrough(whole, [split]), `split at ${split}`).toBe(whole)
    }
  })

  it('close 前扣住的尾部片段在 flush 时补写，不留残余', () => {
    const redactor = createStreamingRedactor()
    const out1 = redactor.push('ending with sk-abc')
    expect(out1).not.toContain('sk-abc')
    const out2 = redactor.flush()
    expect(out1 + out2).toBe('ending with sk-abc')
  })

  it('超过扣留上限的单个超长 token run：强制脱敏落盘，残余 body 只删不漏', () => {
    const giant = `sk-${'x'.repeat(6000)}`
    const redactor = createStreamingRedactor()
    let out = redactor.push('start ')
    out += redactor.push(giant.slice(0, 5000))
    out += redactor.push(giant.slice(5000))
    out += redactor.push(' end\n')
    out += redactor.flush()
    expect(out).toContain('start ')
    expect(out).toContain('sk-<redacted>')
    expect(out).not.toContain('x'.repeat(64))
    expect(out).toContain(' end\n')
  })
})

describe('redactUserContext（反馈诊断包规则层）', () => {
  const ctx = { home: 'C:\\Users\\Alice', hostname: 'ALICE-PC' }

  it('home 两种分隔符写法与主机名原文全部归一', () => {
    const text = 'log at C:\\Users\\Alice\\x.log and C:/Users/Alice/y.log on ALICE-PC'
    const out = redactUserContext(text, ctx)
    expect(out).not.toContain('Alice')
    expect(out).not.toContain('ALICE-PC')
    expect(out).toContain('<USER_HOME>')
    expect(out).toContain('<HOSTNAME>')
  })

  it('任意用户路径用户名段打码且保留结构', () => {
    const out = redactUserContext('C:\\Users\\Bob\\a.txt C:/Users/Carol/b.txt', ctx)
    expect(out).toContain('C:\\Users\\[REDACTED]\\a.txt')
    expect(out).toContain('C:/Users/[REDACTED]/b.txt')
    expect(out).not.toContain('Bob')
    expect(out).not.toContain('Carol')
  })

  it('邮箱、32+ hex token、密钥赋值打码；密钥键名保留', () => {
    const out = redactUserContext(
      'mail bob@example.org ok; hash a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6; DEEPSEEK_API_KEY=hunter2-secret; PASSWORD: p@ss',
      ctx,
    )
    expect(out).not.toContain('bob@example.org')
    expect(out).toContain('[EMAIL]')
    expect(out).not.toContain('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')
    expect(out).not.toContain('hunter2-secret')
    expect(out).not.toContain('p@ss')
    expect(out).toContain('DEEPSEEK_API_KEY=<redacted>')
  })

  it('短 hex 与普通词不受影响（只删不漏，不多打）', () => {
    const out = redactUserContext('deadbeef normal words ok', ctx)
    expect(out).toContain('deadbeef')
    expect(out).toContain('normal words ok')
  })
})
