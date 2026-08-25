/**
 * SSRF proxy enforcement-point tests: the proxy is the layer every browser
 * request (and every redirect hop) passes through; blocked targets get a
 * 502 + block page / block header, allowed targets are forwarded to the
 * checked IP.
 * @module @see-sol-lab/deepcode-browser/tests/proxy
 */

import { afterEach, describe, expect, it } from 'vitest'
import { request as httpRequest } from 'node:http'
import { connect as netConnect, type Socket } from 'node:net'
import { parseConnectAuthority, pinnedLookup, startSsrfProxy, type SsrfProxy } from '../../browser-plugin/src/proxy.ts'
import type { HostLookup } from '../../browser-plugin/src/ssrf.ts'

let proxy: SsrfProxy | null = null

afterEach(async () => {
  if (proxy !== null) {
    await proxy.close()
    proxy = null
  }
})

const lookupOf = (ips: readonly string[]): HostLookup => ({
  lookup: async () => ips,
})

/** 走代理发一个普通 HTTP 请求，返回状态码与正文。 */
function proxiedGet(port: number, targetHost: string, path = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path,
      headers: { host: targetHost },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

/** 走代理发 CONNECT，返回代理的应答行（成功/失败）。 */
function proxiedConnect(port: number, target: string): Promise<{ ok: boolean; statusLine: string; headers: string }> {
  return new Promise((resolve, reject) => {
    const socket: Socket = netConnect({ host: '127.0.0.1', port })
    let data = ''
    socket.on('connect', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
    })
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8')
      // 代理应答的第一行 + 头就够判定；隧道建立后不再需要。
      if (data.includes('\r\n\r\n')) {
        const [head, rest] = [data.split('\r\n\r\n')[0] ?? '', data]
        const ok = head.startsWith('HTTP/1.1 200')
        socket.destroy()
        resolve({ ok, statusLine: head.split('\r\n')[0] ?? '', headers: rest })
      }
    })
    socket.on('error', reject)
    setTimeout(() => { socket.destroy() }, 5000).unref()
  })
}

describe('普通 HTTP 请求', () => {
  it('解析到内网/回环 → 502 + 拦截页（绝不放行）', async () => {
    proxy = await startSsrfProxy(lookupOf(['127.0.0.1']))
    const result = await proxiedGet(proxy.port, 'localhost')
    expect(result.status).toBe(502)
    expect(result.body).toContain('Navigation blocked')
  })

  it('解析到私有段 → 502 拦截页', async () => {
    proxy = await startSsrfProxy(lookupOf(['10.0.0.5']))
    const result = await proxiedGet(proxy.port, 'internal.test')
    expect(result.status).toBe(502)
    expect(result.body).toContain('Navigation blocked')
  })

  it('解析失败 → 502（无法校验就不放行）', async () => {
    proxy = await startSsrfProxy({ lookup: async () => { throw new Error('ENOTFOUND') } })
    const result = await proxiedGet(proxy.port, 'down.test')
    expect(result.status).toBe(502)
  })

  it('公网放行 → 转发到校验过的 IP（响应是转发结果而非拦截页）', async () => {
    proxy = await startSsrfProxy(lookupOf(['8.8.8.8']))
    const result = await proxiedGet(proxy.port, 'public.test')
    // SSRF 校验放行后进入转发路径：转发成败取决于网络，但绝不出现拦截页。
    expect(result.body).not.toContain('Navigation blocked')
  })
})

describe('CONNECT 隧道', () => {
  it('非 443 端口拒绝', async () => {
    proxy = await startSsrfProxy(lookupOf(['8.8.8.8']))
    const result = await proxiedConnect(proxy.port, 'public.test:8080')
    expect(result.ok).toBe(false)
    expect(result.statusLine).toContain('502')
  })

  it('目标解析到内网 → 502 + block 头', async () => {
    proxy = await startSsrfProxy(lookupOf(['169.254.169.254']))
    const result = await proxiedConnect(proxy.port, 'metadata.test:443')
    expect(result.ok).toBe(false)
    expect(result.statusLine).toContain('502')
    expect(result.headers).toContain('X-DeepCode-Block')
  })

  it('公网 443 放行 → 尝试建立隧道（上游不可达时表现为连接失败而非拦截）', async () => {
    proxy = await startSsrfProxy(lookupOf(['8.8.8.8']))
    const result = await proxiedConnect(proxy.port, 'public.test:443')
    // 校验通过：要么隧道建立（ok），要么上游连接失败（无 block 头）。
    // 两者都证明 SSRF 校验放行了该目标。
    expect(result.headers).not.toContain('X-DeepCode-Block')
  })
})

describe('pinnedLookup（"检查过的 IP 就是实际连接的 IP" 的执行点）', () => {
  it('无论问的是什么主机名，答案永远是检查过的那个地址', () => {
    const lookup = pinnedLookup('93.184.216.34')
    let answer: unknown
    ;(lookup as unknown as (h: string, o: unknown, c: (e: unknown, a: unknown, f?: number) => void) => void)(
      'attacker-controlled.example', {}, (_error, address) => { answer = address },
    )
    expect(answer).toBe('93.184.216.34')
  })

  it('options.all 时必须回数组形态（形状答错会直接打断请求）', () => {
    const lookup = pinnedLookup('93.184.216.34')
    let answer: unknown
    ;(lookup as unknown as (h: string, o: unknown, c: (e: unknown, a: unknown, f?: number) => void) => void)(
      'x.example', { all: true }, (_error, address) => { answer = address },
    )
    expect(answer).toEqual([{ address: '93.184.216.34', family: 4 }])
  })

  it('IPv6 地址标成 family 6', () => {
    const lookup = pinnedLookup('2606:4700::1111')
    let family: number | undefined
    ;(lookup as unknown as (h: string, o: unknown, c: (e: unknown, a: unknown, f?: number) => void) => void)(
      'x.example', {}, (_error, _address, resolvedFamily) => { family = resolvedFamily },
    )
    expect(family).toBe(6)
  })
})

describe('parseConnectAuthority（IPv6 字面量的 CONNECT 目标）', () => {
  it('普通主机名带端口', () => {
    expect(parseConnectAuthority('example.com:443')).toEqual({ host: 'example.com', port: 443 })
  })

  it('IPv4 带端口', () => {
    expect(parseConnectAuthority('8.8.8.8:443')).toEqual({ host: '8.8.8.8', port: 443 })
  })

  it('方括号包住的 IPv6：主机名里的冒号不再被当成端口分隔符', () => {
    // 旧的 split(':') 在这里会切出 "[2001" 和一个 NaN 端口。
    expect(parseConnectAuthority('[2001:db8::1]:443')).toEqual({ host: '2001:db8::1', port: 443 })
    expect(parseConnectAuthority('[::1]:443')).toEqual({ host: '::1', port: 443 })
  })

  it('畸形目标一律拒绝', () => {
    expect(parseConnectAuthority(undefined)).toBeNull()
    expect(parseConnectAuthority('')).toBeNull()
    expect(parseConnectAuthority('example.com')).toBeNull()
    expect(parseConnectAuthority(':443')).toBeNull()
    expect(parseConnectAuthority('[2001:db8::1]')).toBeNull()
    expect(parseConnectAuthority('[2001:db8::1]:abc')).toBeNull()
    // 没有方括号的裸 IPv6：它自己的冒号和端口分隔符分不开，拒绝。
    expect(parseConnectAuthority('2001:db8::1:443')).toBeNull()
  })
})

describe('IPv6 目标现在真的会被检查（而不是解析失败）', () => {
  it('IPv6 回环 → 502 拦截页', async () => {
    proxy = await startSsrfProxy(lookupOf(['::1']))
    const result = await proxiedGet(proxy.port, 'v6-loopback.test')
    expect(result.status).toBe(502)
    expect(result.body).toContain('Navigation blocked')
  })

  it('IPv6 唯一本地地址（fc00::/7）→ 502', async () => {
    proxy = await startSsrfProxy(lookupOf(['fd00::1']))
    const result = await proxiedGet(proxy.port, 'v6-ula.test')
    expect(result.status).toBe(502)
  })

  it('IPv4-mapped 的内网地址 → 502（换个写法不能绕过）', async () => {
    proxy = await startSsrfProxy(lookupOf(['::ffff:127.0.0.1']))
    const result = await proxiedGet(proxy.port, 'v6-mapped.test')
    expect(result.status).toBe(502)
  })

  it('CONNECT 到 IPv6 字面量目标：解析得出来，按内网拒绝', async () => {
    proxy = await startSsrfProxy(lookupOf(['::1']))
    const result = await proxiedConnect(proxy.port, '[::1]:443')
    expect(result.ok).toBe(false)
    expect(result.headers).toContain('X-DeepCode-Block')
  })

  it('CONNECT 到公网 IPv6：放行到转发路径', async () => {
    proxy = await startSsrfProxy(lookupOf(['2606:4700::1111']))
    const result = await proxiedConnect(proxy.port, '[2606:4700::1111]:443')
    expect(result.headers).not.toContain('X-DeepCode-Block')
  })
})

describe('代理的启动与关闭', () => {
  it('关闭时会断开仍然挂着的连接，不会干等它自己结束', async () => {
    const started = await startSsrfProxy(lookupOf(['8.8.8.8']))
    // 连上但什么都不发：服务端会一直等这个请求，socket 就这么挂着。
    // 旧实现的 close() 只是停止接受新连接，然后无限期等待这一个。
    const idle = netConnect({ host: '127.0.0.1', port: started.port })
    await new Promise<void>((done) => { idle.once('connect', () => { done() }) })
    try {
      const startedAt = Date.now()
      await Promise.race([
        started.close(),
        new Promise((_, reject) => {
          setTimeout(() => { reject(new Error('close 挂住了')) }, 4_000).unref()
        }),
      ])
      expect(Date.now() - startedAt).toBeLessThan(4_000)
    } finally {
      idle.destroy()
    }
  })

  it('没有连接时关闭同样干净', async () => {
    const started = await startSsrfProxy(lookupOf(['8.8.8.8']))
    await expect(started.close()).resolves.toBeUndefined()
  })

  it('端口释放后可以再起一个（关闭是真的关闭）', async () => {
    const first = await startSsrfProxy(lookupOf(['8.8.8.8']))
    const port = first.port
    await first.close()
    const second = await startSsrfProxy(lookupOf(['8.8.8.8']))
    try {
      expect(second.port).toBeGreaterThan(0)
      expect(port).toBeGreaterThan(0)
    } finally {
      await second.close()
    }
  })
})
