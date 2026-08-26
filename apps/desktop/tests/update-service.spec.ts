/**
 * update-service 测试：语义版本比较与 prerelease policy、manifest 严格
 * 解析、URL/filename 卫生、摘要校验与 handoff 决策。纯 Node 环境，
 * 无网络、无 Electron、无凭据。
 * @module @see-sol-lab/deepcode/tests/update-service
 */

import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  DEFAULT_UPDATE_FEED_URL,
  isNewerStable,
  isSafeAssetUrl,
  isVersionShape,
  parseUpdateManifest,
  resolveUpdateFeed,
  sanitizeAssetFilename,
  sha256Stream,
  shouldReuseVerifiedInstaller,
  MAX_UPDATE_REDIRECTS,
  resolveRedirectTarget,
  streamDownload,
  verifyDigest,
  UPDATE_SIZE_LIMIT,
  UpdateManifestError,
  UpdateVersionError,
  type HttpGet,
} from '../src/update-service.ts'

describe('resolveUpdateFeed（V1 内置公开通道 + 用户覆盖）', () => {
  it('没有覆盖配置 → 内置公开通道（普通用户的默认情形）', () => {
    expect(resolveUpdateFeed(null)).toBe(DEFAULT_UPDATE_FEED_URL)
  })

  it('内置通道是 https 的 GitHub releases 固定别名（发版只需上传同名资产）', () => {
    expect(new URL(DEFAULT_UPDATE_FEED_URL).protocol).toBe('https:')
    expect(DEFAULT_UPDATE_FEED_URL).toContain('/releases/latest/download/')
  })

  it('合法覆盖配置优先于内置默认（私有部署与测试靠它）', () => {
    expect(resolveUpdateFeed('{"feedUrl":"https://example.test/m.json"}')).toBe('https://example.test/m.json')
  })

  it('配置存在但非法 → 明确未配置，绝不悄悄回落到内置默认', () => {
    // 用户显式配置过通道，把他写错的配置换成我们的地址，等于拿另一个
    // 来源冒充他指定的那个——宁可 unconfigured，也不替他做主。
    expect(resolveUpdateFeed('{"feedUrl":"http://plain.test/m.json"}')).toBeNull()
    expect(resolveUpdateFeed('{"feedUrl":""}')).toBeNull()
    expect(resolveUpdateFeed('{"feedUrl":123}')).toBeNull()
    expect(resolveUpdateFeed('not json at all')).toBeNull()
    expect(resolveUpdateFeed('{}')).toBeNull()
  })
})

describe('compareVersions（语义版本 + prerelease 规则）', () => {
  it('数字段比较', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('0.1.1', '0.1.0')).toBe(1)
    expect(compareVersions('0.0.9', '0.1.0')).toBe(-1)
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1)
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
  })

  it('prerelease：正式 > prerelease；alpha < beta < rc；数字段 < 字母段', () => {
    expect(compareVersions('0.2.0', '0.2.0-beta.1')).toBe(1)
    expect(compareVersions('0.2.0-alpha.1', '0.2.0-beta.1')).toBe(-1)
    expect(compareVersions('0.2.0-beta.2', '0.2.0-rc.1')).toBe(-1)
    expect(compareVersions('0.1.0-alpha.2', '0.1.0-alpha.10')).toBe(-1)
    expect(compareVersions('0.1.0-alpha', '0.1.0-alpha.1')).toBe(-1)
  })

  it('非法形态抛 UpdateVersionError，绝不猜测', () => {
    expect(() => compareVersions('1.0', '1.0.0')).toThrow(UpdateVersionError)
    expect(() => compareVersions('v1.0.0', '1.0.0')).toThrow(UpdateVersionError)
    expect(() => compareVersions('', '1.0.0')).toThrow(UpdateVersionError)
  })
})

describe('isNewerStable（只有 strictly newer stable 才提示）', () => {
  it('stable 且更新 → true', () => {
    expect(isNewerStable('0.2.0', '0.1.0')).toBe(true)
  })
  it('相同/更旧/非法 → false', () => {
    expect(isNewerStable('0.1.0', '0.1.0')).toBe(false)
    expect(isNewerStable('0.0.9', '0.1.0')).toBe(false)
    expect(isNewerStable('bogus', '0.1.0')).toBe(false)
    expect(isNewerStable('0.2.0', 'bogus')).toBe(false)
  })
  it('prerelease latest 永不提示', () => {
    expect(isNewerStable('0.2.0-beta.1', '0.1.0')).toBe(false)
  })
})

describe('isVersionShape', () => {
  it.each(['0.1.0', '0.1.0-alpha.1', '10.20.30', '1.0.0-rc.1.build.2'])('合法 %s', (v) => {
    expect(isVersionShape(v)).toBe(true)
  })
  it.each(['1.0', 'v1.0.0', '1.0.0+meta', '', ' 1.0.0'])('非法 %s', (v) => {
    expect(isVersionShape(v)).toBe(false)
  })
})

const MANIFEST = JSON.stringify({
  latestVersion: '0.2.0',
  releaseNotes: '修复若干问题\n新增更新通道',
  assets: [{
    url: 'https://updates.example.com/DeepCode-Setup-0.2.0.exe',
    sha256: 'a'.repeat(64),
    size: 123456789,
    filename: 'DeepCode-Setup-0.2.0.exe',
  }],
})

describe('parseUpdateManifest（严格 schema，绝不猜测）', () => {
  it('合法 manifest 解析', () => {
    const manifest = parseUpdateManifest(MANIFEST)
    expect(manifest.latestVersion).toBe('0.2.0')
    expect(manifest.releaseNotes).toContain('修复')
    expect(manifest.assets).toHaveLength(1)
    expect(manifest.assets[0]!.sha256).toBe('a'.repeat(64))
  })

  it.each([
    ['非 JSON', 'not json'],
    ['顶层非对象', '[]'],
    ['latestVersion 非法', JSON.stringify({ latestVersion: '0.2', releaseNotes: '', assets: [] })],
    ['latestVersion 是 prerelease', JSON.stringify({ latestVersion: '0.2.0-beta', releaseNotes: '', assets: [] })],
    ['releaseNotes 非字符串', JSON.stringify({ latestVersion: '0.2.0', releaseNotes: 42, assets: [] })],
    ['assets 空', JSON.stringify({ latestVersion: '0.2.0', releaseNotes: '', assets: [] })],
    ['assets 非数组', JSON.stringify({ latestVersion: '0.2.0', releaseNotes: '', assets: {} })],
  ])('拒绝：%s', (_name, text) => {
    expect(() => parseUpdateManifest(text)).toThrow(UpdateManifestError)
  })

  it('资产条目逐项校验：非 https / 非法 sha256 / 非正 size / 非法 filename', () => {
    const base = JSON.parse(MANIFEST) as { assets: unknown[] }
    const bad = (asset: Record<string, unknown>): string =>
      JSON.stringify({ ...JSON.parse(MANIFEST) as object, assets: [asset] })
    void base
    expect(() => parseUpdateManifest(bad({ url: 'http://x/y.exe', sha256: 'a'.repeat(64), size: 1, filename: 'a.exe' })))
      .toThrow(/HTTPS/)
    expect(() => parseUpdateManifest(bad({ url: 'file:///C:/x.exe', sha256: 'a'.repeat(64), size: 1, filename: 'a.exe' })))
      .toThrow(/HTTPS/)
    expect(() => parseUpdateManifest(bad({ url: 'https://x/y.exe', sha256: 'zz', size: 1, filename: 'a.exe' })))
      .toThrow(/sha256/)
    expect(() => parseUpdateManifest(bad({ url: 'https://x/y.exe', sha256: 'a'.repeat(64), size: 0, filename: 'a.exe' })))
      .toThrow(/size/)
    expect(() => parseUpdateManifest(bad({ url: 'https://x/y.exe', sha256: 'a'.repeat(64), size: 1, filename: '../evil.exe' })))
      .toThrow(/filename/)
  })
})

describe('parseUpdateAsset / sanitizeAssetFilename / isSafeAssetUrl', () => {
  it('sanitize：只留 basename 与安全字符', () => {
    expect(sanitizeAssetFilename('DeepCode-Setup-0.2.0.exe')).toBe('DeepCode-Setup-0.2.0.exe')
    expect(sanitizeAssetFilename('C:\\evil\\path\\a.exe')).toBe('a.exe')
    expect(sanitizeAssetFilename('../../a.exe')).toBe('a.exe')
    expect(sanitizeAssetFilename('a b.exe')).toBeNull()
    expect(sanitizeAssetFilename('a&b.exe')).toBeNull()
    expect(sanitizeAssetFilename('..')).toBeNull()
    expect(sanitizeAssetFilename('')).toBeNull()
  })

  it('isSafeAssetUrl：仅 https', () => {
    expect(isSafeAssetUrl('https://x/y.exe')).toBe(true)
    expect(isSafeAssetUrl('http://x/y.exe')).toBe(false)
    expect(isSafeAssetUrl('file:///C:/x')).toBe(false)
    expect(isSafeAssetUrl('C:\\x\\y.exe')).toBe(false)
    expect(isSafeAssetUrl('not a url')).toBe(false)
  })
})

describe('verifyDigest（mismatch 绝不执行）', () => {
  const expected = 'a'.repeat(64)
  it('匹配 → ok', () => {
    expect(verifyDigest(expected, expected)).toEqual({ ok: true })
  })
  it('不匹配 / 非 hex / 长度错 → 明确失败', () => {
    expect(verifyDigest(expected, 'b'.repeat(64)).ok).toBe(false)
    expect(verifyDigest(expected, 'xyz').ok).toBe(false)
    expect(verifyDigest(expected, 'a'.repeat(63)).ok).toBe(false)
  })
})

describe('shouldReuseVerifiedInstaller（single-slot 复用决策）', () => {
  const expected = { sha256: 'a'.repeat(64), size: 1, filename: 'x.exe' }
  it('同版本同 digest → 复用', () => {
    expect(shouldReuseVerifiedInstaller('a'.repeat(64), '0.2.0', expected, '0.2.0')).toBe(true)
  })
  it('版本不同 / digest 不同 / 无记录 → 不复用', () => {
    expect(shouldReuseVerifiedInstaller('a'.repeat(64), '0.1.0', expected, '0.2.0')).toBe(false)
    expect(shouldReuseVerifiedInstaller('b'.repeat(64), '0.2.0', expected, '0.2.0')).toBe(false)
    expect(shouldReuseVerifiedInstaller(null, null, expected, '0.2.0')).toBe(false)
  })
})

describe('UPDATE_SIZE_LIMIT', () => {
  it('为合理的正数上限', () => {
    expect(UPDATE_SIZE_LIMIT).toBeGreaterThan(0)
  })
})

describe('streamDownload（size limit / cancel / HTTP 错误 / 进度）', () => {
  // fake HTTP：按脚本推流；类型与 HttpGet 注入面完全一致。
  const fakeGet = (script: (emit: (event: string, arg?: unknown) => void) => void): HttpGet => {
    const fn: HttpGet = (url, callback) => {
      void url
      const handlers = new Map<string, ((arg: unknown) => void)[]>()
      const response = {
        statusCode: 200,
        on: (event: string, handler: (arg: unknown) => void): void => {
          const list = handlers.get(event) ?? []
          list.push(handler)
          handlers.set(event, list)
        },
      }
      callback(response)
      const emit = (event: string, arg?: unknown): void => {
        for (const handler of handlers.get(event) ?? []) handler(arg)
      }
      // 异步推流（贴近真实网络）：get 先返回、abort 监听器注册完成后
      // 脚本才跑——同步 emit 会在 signal 监听就位前触发数据。
      setTimeout(() => {
        script(emit)
      }, 0)
      return {
        on: (_event: string, _handler: (arg: unknown) => void): void => {
          // 请求层错误脚本不触发
        },
      }
    }
    return fn
  }

  it('完整下载：进度回调累计、返回总字节', async () => {
    const writes: Uint8Array[] = []
    const progress: number[] = []
    const get = fakeGet((emit) => {
      emit('data', new Uint8Array([1, 2, 3]))
      emit('data', new Uint8Array([4, 5]))
      emit('end')
    })
    const result = await streamDownload(
      'https://x/a.exe',
      chunk => writes.push(chunk),
      1024,
      new AbortController().signal,
      bytes => progress.push(bytes),
      get,
    )
    expect(result.bytes).toBe(5)
    expect(progress).toEqual([3, 5])
    expect(writes.map(chunk => chunk.length)).toEqual([3, 2])
  })

  it('超出 size limit 立即中止并明确报错', async () => {
    const get = fakeGet((emit) => {
      emit('data', new Uint8Array(10))
      emit('data', new Uint8Array(10))
      emit('end')
    })
    await expect(streamDownload(
      'https://x/a.exe',
      () => {},
      15,
      new AbortController().signal,
      () => {},
      get,
    )).rejects.toThrow(/大小上限/)
  })

  it('AbortSignal 取消：立即抛"下载已取消"', async () => {
    const controller = new AbortController()
    const get = fakeGet((emit) => {
      emit('data', new Uint8Array(10))
      controller.abort()
      emit('data', new Uint8Array(10))
      emit('end')
    })
    await expect(streamDownload(
      'https://x/a.exe',
      () => {},
      1024,
      controller.signal,
      () => {},
      get,
    )).rejects.toThrow(/已取消/)
  })

  it('HTTP 非 2xx：明确失败', async () => {
    const failingGet: HttpGet = (url, callback) => {
      void url
      callback({ statusCode: 500, on: () => {} })
      return { on: () => {} }
    }
    await expect(streamDownload(
      'https://x/a.exe', () => {}, 1024, new AbortController().signal, () => {},
      failingGet,
    )).rejects.toThrow(/HTTP 500/)
  })

  // 404 与「出错了」是两回事：`releases/latest/download/<asset>` 在还没有任何
  // release 时就是 404。人工验收（2026-08-27）实测：发布前点检查更新，用户看到
  // 「下载失败：HTTP 404」只会以为程序坏了。
  it('HTTP 404：说成「没有可用更新」，不说成下载失败', async () => {
    const notFoundGet: HttpGet = (url, callback) => {
      void url
      callback({ statusCode: 404, on: () => {} })
      return { on: () => {} }
    }
    await expect(streamDownload(
      'https://x/a.exe', () => {}, 1024, new AbortController().signal, () => {},
      notFoundGet,
    )).rejects.toThrow(/没有可用的更新/)
  })

  it('写入失败：明确报错且不再继续', async () => {
    const get = fakeGet((emit) => {
      emit('data', new Uint8Array(10))
    })
    await expect(streamDownload(
      'https://x/a.exe',
      () => { throw new Error('disk full') },
      1024,
      new AbortController().signal,
      () => {},
      get,
    )).rejects.toThrow(/disk full/)
  })
})

describe('sha256Stream（安装前校验的流式摘要）', () => {
  /** 把整块内容按给定块大小切开喂进去，模拟任意的流切分方式。 */
  const chunked = (bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> => ({
    async *[Symbol.asyncIterator]() {
      for (let offset = 0; offset < bytes.length; offset += size) {
        yield bytes.subarray(offset, Math.min(offset + size, bytes.length))
      }
    },
  })

  /** 与产品同源的期望值：整块一次性哈希。 */
  const digestOf = async (bytes: Uint8Array): Promise<string> => {
    const { createHash } = await import('node:crypto')
    return createHash('sha256').update(bytes).digest('hex')
  }

  it('结果与整块一次性哈希一致，且与切分方式无关', async () => {
    const bytes = new Uint8Array(64 * 1024 + 7)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) % 256
    const expected = await digestOf(bytes)
    for (const size of [1, 7, 4096, 65_536, bytes.length]) {
      expect(await sha256Stream(chunked(bytes, size))).toBe(expected)
    }
  })

  it('空内容返回空串的摘要（不是抛错、不是空值）', async () => {
    expect(await sha256Stream(chunked(new Uint8Array(0), 16))).toBe(await digestOf(new Uint8Array(0)))
  })

  it('流中途抛错时向上抛，绝不返回一个"算到一半"的摘要', async () => {
    const failing: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array([1, 2, 3])
        throw new Error('read failed')
      },
    }
    await expect(sha256Stream(failing)).rejects.toThrow(/read failed/)
  })
})


describe('streamDownload 跟随重定向（GitHub latest/download 的正常链路）', () => {
  /**
   * 按 URL 路由的 fake：每个地址要么给一个跳转，要么给一段内容。
   * 真实 GitHub 的 releases/latest/download 就是先 302 到打了签名的
   * 对象存储地址，所以"跟不跟跳转"直接决定默认更新通道能不能用。
   */
  const routedGet = (routes: Record<string, { status: number; location?: string; body?: number[] }>): HttpGet => {
    const fn: HttpGet = (url, callback) => {
      const route = routes[url]
      if (route === undefined) throw new Error(`fake 未定义的地址：${url}`)
      const handlers = new Map<string, ((arg: unknown) => void)[]>()
      callback({
        statusCode: route.status,
        headers: route.location === undefined ? {} : { location: route.location },
        on: (event: string, handler: (arg: unknown) => void): void => {
          const list = handlers.get(event) ?? []
          list.push(handler)
          handlers.set(event, list)
        },
      })
      setTimeout(() => {
        const emit = (event: string, arg?: unknown): void => {
          for (const handler of handlers.get(event) ?? []) handler(arg)
        }
        if (route.body !== undefined) {
          emit('data', new Uint8Array(route.body))
          emit('end')
        }
      }, 0)
      return { on: () => {}, destroy: () => {} }
    }
    return fn
  }

  const run = async (routes: Parameters<typeof routedGet>[0], start = 'https://github.com/o/r/releases/latest/download/a.exe'): Promise<{ bytes: number; written: number[] }> => {
    const written: number[] = []
    const result = await streamDownload(
      start,
      (chunk) => { written.push(...chunk) },
      1024,
      new AbortController().signal,
      () => {},
      routedGet(routes),
    )
    return { bytes: result.bytes, written }
  }

  it('相对 Location：GitHub 的 302 就是相对形式', async () => {
    const outcome = await run({
      'https://github.com/o/r/releases/latest/download/a.exe': { status: 302, location: '/o/r/releases/download/v1.0.1/a.exe' },
      'https://github.com/o/r/releases/download/v1.0.1/a.exe': { status: 200, body: [1, 2, 3] },
    })
    expect(outcome.bytes).toBe(3)
    expect(outcome.written).toEqual([1, 2, 3])
  })

  it('绝对 Location：跳到对象存储域名', async () => {
    const outcome = await run({
      'https://github.com/o/r/releases/latest/download/a.exe': { status: 302, location: 'https://objects.example.com/signed/a.exe' },
      'https://objects.example.com/signed/a.exe': { status: 200, body: [7, 7] },
    })
    expect(outcome.bytes).toBe(2)
  })

  it('多跳但在上限内：正常下完', async () => {
    const routes: Record<string, { status: number; location?: string; body?: number[] }> = {}
    for (let i = 0; i < MAX_UPDATE_REDIRECTS; i++) {
      routes[`https://h/${String(i)}`] = { status: 302, location: `https://h/${String(i + 1)}` }
    }
    routes[`https://h/${String(MAX_UPDATE_REDIRECTS)}`] = { status: 200, body: [9] }
    const outcome = await run(routes, 'https://h/0')
    expect(outcome.bytes).toBe(1)
  })

  it('超过跳数上限：明确停止，不无限跟下去', async () => {
    const routes: Record<string, { status: number; location?: string; body?: number[] }> = {}
    for (let i = 0; i <= MAX_UPDATE_REDIRECTS + 2; i++) {
      routes[`https://h/${String(i)}`] = { status: 302, location: `https://h/${String(i + 1)}` }
    }
    await expect(run(routes, 'https://h/0')).rejects.toThrow(/跳转超过/)
  })

  it('跳转成环：绕回走过的地址就停', async () => {
    await expect(run({
      'https://h/a': { status: 302, location: 'https://h/b' },
      'https://h/b': { status: 302, location: 'https://h/a' },
    }, 'https://h/a')).rejects.toThrow(/绕回/)
  })

  it('降级到 HTTP：拒绝（中间人可以换掉安装包）', async () => {
    await expect(run({
      'https://h/a': { status: 302, location: 'http://h/a' },
    }, 'https://h/a')).rejects.toThrow(/非 HTTPS/)
  })

  it('跳转到带账号密码的地址：拒绝', async () => {
    await expect(run({
      'https://h/a': { status: 302, location: 'https://user:secret@h/b' },
    }, 'https://h/a')).rejects.toThrow(/账号密码/)
  })

  it('3xx 但没有 Location：明确报错，不当成下载失败', async () => {
    await expect(run({
      'https://h/a': { status: 302 },
    }, 'https://h/a')).rejects.toThrow(/没有给出目标地址/)
  })

  it('Location 是解析不了的绝对地址：明确报错', async () => {
    // 注意畸形 Location 的常态：'ht!tp://x' 这类会被当成相对路径吃掉，
    // 解析成 https://h/ht!tp://x 而不报错——那条路仍受 https 与凭据检查
    // 约束，所以安全。真正解析失败的是非法的绝对地址，比如残缺的 IPv6。
    await expect(run({
      'https://h/a': { status: 302, location: 'https://[' },
    }, 'https://h/a')).rejects.toThrow(/无法解析/)
  })

  it('301 / 307 / 308 一视同仁（我们只做 GET）', async () => {
    for (const status of [301, 307, 308]) {
      const outcome = await run({
        'https://h/a': { status, location: 'https://h/b' },
        'https://h/b': { status: 200, body: [5] },
      }, 'https://h/a')
      expect(outcome.bytes).toBe(1)
    }
  })
})

describe('resolveRedirectTarget（跳转地址的卫生）', () => {
  it('相对路径按当前地址解析', () => {
    expect(resolveRedirectTarget('https://h/x/y', '/z')).toBe('https://h/z')
    expect(resolveRedirectTarget('https://h/x/y', 'z')).toBe('https://h/x/z')
  })

  it('Location 缺失 / 空串 / 非字符串都拒绝', () => {
    expect(() => resolveRedirectTarget('https://h/a', undefined)).toThrow(/没有给出目标地址/)
    expect(() => resolveRedirectTarget('https://h/a', '   ')).toThrow(/没有给出目标地址/)
    expect(() => resolveRedirectTarget('https://h/a', 42)).toThrow(/没有给出目标地址/)
  })

  it('非 HTTPS 一律拒绝（含 file: 与 data:）', () => {
    expect(() => resolveRedirectTarget('https://h/a', 'http://h/a')).toThrow(/非 HTTPS/)
    expect(() => resolveRedirectTarget('https://h/a', 'file:///C:/x.exe')).toThrow(/非 HTTPS/)
    expect(() => resolveRedirectTarget('https://h/a', 'data:text/plain,x')).toThrow(/非 HTTPS/)
  })

  it('带凭据的地址拒绝（会漏进日志与诊断包）', () => {
    expect(() => resolveRedirectTarget('https://h/a', 'https://u:p@h/b')).toThrow(/账号密码/)
    expect(() => resolveRedirectTarget('https://h/a', 'https://u@h/b')).toThrow(/账号密码/)
  })
})

describe('更新地址不接受嵌在 URL 里的凭据', () => {
  it('feed 配置带账号密码 → 视为未配置', () => {
    expect(resolveUpdateFeed(JSON.stringify({ feedUrl: 'https://u:p@example.com/m.json' }))).toBeNull()
    expect(resolveUpdateFeed(JSON.stringify({ feedUrl: 'https://u@example.com/m.json' }))).toBeNull()
  })

  it('干净的 https feed 仍然接受', () => {
    const url = 'https://example.com/m.json'
    expect(resolveUpdateFeed(JSON.stringify({ feedUrl: url }))).toBe(url)
  })

  it('资产 URL 带凭据 → 拒绝', () => {
    expect(isSafeAssetUrl('https://u:p@example.com/a.exe')).toBe(false)
    expect(isSafeAssetUrl('https://example.com/a.exe')).toBe(true)
  })
})
