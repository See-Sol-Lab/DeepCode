/**
 * SSRF gate full-matrix unit tests (菲博 §7.3.1): loopback / private /
 * link-local / cloud metadata / non-http(s) schemes / DNS rebinding (mock
 * resolver) / URL hygiene. Every navigation target must pass before bytes
 * move; localhost (incl. DeepCode's own 3080/control bridge) is blocked by
 * design, never exempted.
 * @module @see-sol-lab/deepcode-browser/tests/ssrf
 */

import { describe, expect, it } from 'vitest'
import {
  isBlockedIp,
  parseIpv4,
  resolveChecked,
  validateNavigationTarget,
  stripIpv6Brackets,
  validateUrlHygiene,
  type HostLookup,
} from '../../browser-plugin/src/ssrf.ts'

const lookupOf = (ips: readonly string[]): HostLookup => ({
  lookup: async () => ips,
})

describe('IPv4 分类（isBlockedIpv4 / parseIpv4）', () => {
  it('回环 127.0.0.0/8 全拦截', () => {
    expect(isBlockedIp('127.0.0.1')).toBe(true)
    expect(isBlockedIp('127.1.2.3')).toBe(true)
    expect(isBlockedIp('127.255.255.255')).toBe(true)
  })

  it('私有段 10/8、172.16/12、192.168/16 拦截，边界精确', () => {
    expect(isBlockedIp('10.0.0.0')).toBe(true)
    expect(isBlockedIp('10.255.255.255')).toBe(true)
    expect(isBlockedIp('172.15.255.255')).toBe(false)
    expect(isBlockedIp('172.16.0.0')).toBe(true)
    expect(isBlockedIp('172.31.255.255')).toBe(true)
    expect(isBlockedIp('172.32.0.0')).toBe(false)
    expect(isBlockedIp('192.168.0.1')).toBe(true)
    expect(isBlockedIp('192.169.0.1')).toBe(false)
  })

  it('link-local 169.254/16（含云元数据 169.254.169.254）拦截', () => {
    expect(isBlockedIp('169.254.0.1')).toBe(true)
    expect(isBlockedIp('169.254.169.254')).toBe(true)
    expect(isBlockedIp('169.255.0.1')).toBe(false)
  })

  it('CGNAT 100.64/10、文档段、多播、保留、0/8 拦截', () => {
    expect(isBlockedIp('100.64.0.1')).toBe(true)
    expect(isBlockedIp('100.127.255.255')).toBe(true)
    expect(isBlockedIp('100.128.0.1')).toBe(false)
    expect(isBlockedIp('192.0.2.1')).toBe(true)
    expect(isBlockedIp('198.51.100.1')).toBe(true)
    expect(isBlockedIp('203.0.113.1')).toBe(true)
    expect(isBlockedIp('224.0.0.1')).toBe(true)
    expect(isBlockedIp('239.255.255.255')).toBe(true)
    expect(isBlockedIp('240.0.0.1')).toBe(true)
    expect(isBlockedIp('255.255.255.255')).toBe(true)
    expect(isBlockedIp('0.0.0.0')).toBe(true)
  })

  it('公网 IPv4 放行', () => {
    expect(isBlockedIp('8.8.8.8')).toBe(false)
    expect(isBlockedIp('1.1.1.1')).toBe(false)
    expect(isBlockedIp('93.184.216.34')).toBe(false)
  })

  it('畸形地址视为不可连接（fail closed）', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true)
    expect(isBlockedIp('256.1.1.1')).toBe(true)
    expect(isBlockedIp('1.2.3')).toBe(true)
    expect(parseIpv4('1.2.3.4')).toBe(0x0102_0304)
    expect(Number.isNaN(parseIpv4('1.2.3'))).toBe(true)
  })
})

describe('IPv6 分类（isBlockedIpv6）', () => {
  it(':: 与 ::1 拦截', () => {
    expect(isBlockedIp('::')).toBe(true)
    expect(isBlockedIp('::1')).toBe(true)
  })

  it('IPv4 映射 ::ffff:a.b.c.d 按内嵌 IPv4 判定', () => {
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true)
    expect(isBlockedIp('::ffff:10.0.0.1')).toBe(true)
    expect(isBlockedIp('::ffff:8.8.8.8')).toBe(false)
  })

  it('ULA fc00::/7、link-local fe80::/10、多播 ff00::/8 拦截', () => {
    expect(isBlockedIp('fc00::1')).toBe(true)
    expect(isBlockedIp('fd12:3456::1')).toBe(true)
    expect(isBlockedIp('fe80::1')).toBe(true)
    expect(isBlockedIp('febf::1')).toBe(true)
    expect(isBlockedIp('ff02::1')).toBe(true)
  })

  it('公网 IPv6 放行', () => {
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false)
    expect(isBlockedIp('2001:4860:4860::8888')).toBe(false)
  })

  // ↓ 2026-08-24 review 修复：此前按文本前缀匹配，凡不认识的写法一律放行
  // （fail open）。同一个地址的另一种拼法就能绕过整条内网防线。
  it('十六进制写法的 IPv4 映射同样按内嵌 IPv4 判定（曾放行 ::ffff:7f00:1）', () => {
    expect(isBlockedIp('::ffff:7f00:1')).toBe(true) // 127.0.0.1
    expect(isBlockedIp('::ffff:a00:1')).toBe(true) // 10.0.0.1
    expect(isBlockedIp('::ffff:c0a8:1')).toBe(true) // 192.168.0.1
    expect(isBlockedIp('::ffff:a9fe:a9fe')).toBe(true) // 169.254.169.254 云元数据
    expect(isBlockedIp('::ffff:808:808')).toBe(false) // 8.8.8.8 仍放行
  })

  it('完全展开写法与零压缩变体同样拦截（曾放行 0:0:0:0:0:0:0:1）', () => {
    expect(isBlockedIp('0:0:0:0:0:0:0:1')).toBe(true)
    expect(isBlockedIp('0000:0000:0000:0000:0000:0000:0000:0001')).toBe(true)
    expect(isBlockedIp('0:0:0:0:0:ffff:7f00:1')).toBe(true)
    expect(isBlockedIp('::127.0.0.1')).toBe(true) // IPv4 兼容写法
  })

  it('站点本地/6to4/Teredo/NAT64/文档段拦截（曾全部放行）', () => {
    expect(isBlockedIp('fec0::1')).toBe(true) // fec0::/10 site-local
    expect(isBlockedIp('2002:c0a8:0101::1')).toBe(true) // 6to4
    expect(isBlockedIp('2001:0:5ef5:79fb::1')).toBe(true) // Teredo
    expect(isBlockedIp('64:ff9b::7f00:1')).toBe(true) // NAT64 内嵌 127.0.0.1
    expect(isBlockedIp('2001:db8::1')).toBe(true) // 文档段
  })

  it('无法解析的 IPv6 一律拦截（fail closed，与 IPv4 侧同则）', () => {
    expect(isBlockedIp('::ffff:zzzz')).toBe(true)
    expect(isBlockedIp('1:2:3:4:5:6:7')).toBe(true) // 组数不足且无 ::
    expect(isBlockedIp('1:2:3:4:5:6:7:8:9')).toBe(true) // 组数过多
    expect(isBlockedIp('::1::2')).toBe(true) // 多个 ::
    expect(isBlockedIp(':')).toBe(true)
  })

  it('带 %zone 的 link-local 照常拦截', () => {
    expect(isBlockedIp('fe80::1%eth0')).toBe(true)
  })
})

describe('URL 卫生（validateUrlHygiene）', () => {
  it('只接受 http(s)，拒绝 file/ftp/data 等协议', () => {
    expect(validateUrlHygiene('file:///etc/passwd', 2048).ok).toBe(false)
    expect(validateUrlHygiene('ftp://example.com/x', 2048).ok).toBe(false)
    expect(validateUrlHygiene('data:text/html,hi', 2048).ok).toBe(false)
    expect(validateUrlHygiene('javascript:alert(1)', 2048).ok).toBe(false)
    expect(validateUrlHygiene('https://example.com/', 2048).ok).toBe(true)
  })

  it('拒绝超长 URL 与内嵌凭据', () => {
    const hygiene = validateUrlHygiene('https://example.com/', 10)
    expect(hygiene.ok).toBe(false)
    if (!hygiene.ok) expect(hygiene.reason).toBe('url-too-long')
    expect(validateUrlHygiene('https://user:pass@example.com/', 2048).ok).toBe(false)
    expect(validateUrlHygiene('not a url', 2048).ok).toBe(false)
  })

  it('URL 卫生通过后 host 提取正确', () => {
    const ok = validateUrlHygiene('https://example.com:8443/path?q=1', 2048)
    expect(ok).toMatchObject({ ok: true, host: 'example.com' })
  })
})

describe('DNS 重绑定防线（resolveChecked + validateNavigationTarget）', () => {
  it('解析到任一内网 IP 即拒绝（混合结果也一样）', async () => {
    expect((await resolveChecked('evil.test', lookupOf(['8.8.8.8', '127.0.0.1']))).ok).toBe(false)
    expect((await resolveChecked('evil.test', lookupOf(['10.0.0.1']))).ok).toBe(false)
    expect((await resolveChecked('evil.test', lookupOf(['169.254.169.254']))).ok).toBe(false)
    expect((await resolveChecked('evil.test', lookupOf(['::ffff:192.168.1.1']))).ok).toBe(false)
  })

  it('全公网解析放行并返回校验过的 IP 列表', async () => {
    const verdict = await resolveChecked('good.test', lookupOf(['8.8.8.8', '1.1.1.1']))
    expect(verdict).toEqual({ ok: true, host: 'good.test', ips: ['8.8.8.8', '1.1.1.1'] })
  })

  it('解析失败 / 空结果拒绝（无法校验就不放行）', async () => {
    expect((await resolveChecked('down.test', { lookup: async () => { throw new Error('ENOTFOUND') } })).ok).toBe(false)
    expect((await resolveChecked('empty.test', lookupOf([]))).ok).toBe(false)
  })

  it('完整导航门禁：URL 卫生 → 解析 → 校验', async () => {
    expect((await validateNavigationTarget('https://public.test/', lookupOf(['8.8.8.8']))).ok).toBe(true)
    expect((await validateNavigationTarget('http://localhost:3080/', lookupOf(['127.0.0.1']))).ok).toBe(false)
    expect((await validateNavigationTarget('http://192.168.1.5/', lookupOf(['192.168.1.5']))).ok).toBe(false)
    expect((await validateNavigationTarget('https://127.0.0.1/', lookupOf(['127.0.0.1']))).ok).toBe(false)
    // DeepCode 自己的控制桥就是 localhost：被正确拦截是特性不是 bug。
    expect((await validateNavigationTarget('http://127.0.0.1:3080/control/model', lookupOf(['127.0.0.1']))).ok).toBe(false)
  })
})

describe('IPv6 字面量在 hygiene 层就要脱掉方括号', () => {
  it('URL 解析保留的方括号必须剥掉，否则 DNS 那一步必然失败', () => {
    // WHATWG URL 的 hostname 对 IPv6 是 '[::1]'，而 dns.lookup('[::1]')
    // 直接报错——于是 IPv6 目标过去一律以无法解析主机被拒，而不是
    // 按它自己的地址性质判断。
    const verdict = validateUrlHygiene('https://[::1]/', 2048)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.host).toBe('::1')
  })

  it('公网 IPv6 字面量同样剥括号', () => {
    const verdict = validateUrlHygiene('https://[2606:4700::1111]/path', 2048)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.host).toBe('2606:4700::1111')
  })

  it('普通主机名不受影响', () => {
    const verdict = validateUrlHygiene('https://example.com/x', 2048)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.host).toBe('example.com')
  })

  it('stripIpv6Brackets 只动成对的方括号', () => {
    expect(stripIpv6Brackets('[::1]')).toBe('::1')
    expect(stripIpv6Brackets('example.com')).toBe('example.com')
    expect(stripIpv6Brackets('[unclosed')).toBe('[unclosed')
  })
})
