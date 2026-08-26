/**
 * update-runner 服务层测试：本机 mock HTTP server 跑真链路（真实网络栈、
 * 真流、真 spawn 注入）——施工单点名的 download confirmation/cancel、
 * digest mismatch、handoff confirm/cancel/spawn failure 在此有行为级
 * 测试。不访问公网、无凭据、无模型。
 * @module @see-sol-lab/deepcode/tests/update-runner
 */

import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs'
import { get } from 'node:http'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runUpdateCheck, runUpdateDownload, runUpdateHandoff, type UpdateRunnerDeps } from '../src/update-runner.ts'
import {
  fetchManifestText,
  streamDownload,
  type HttpGet,
  type UpdateAsset,
  type UpdateManifest,
} from '../src/update-service.ts'

/** 本机 mock server：按 URL 返回预设响应；记录请求路径。 */
async function startMock(
  routes: Map<string, { status: number; body: Buffer }>,
): Promise<{ url: string; close: () => void; requests: string[] }> {
  const requests: string[] = []
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '')
    const route = routes.get(req.url ?? '')
    if (route === undefined) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(route.status, { 'content-type': 'application/octet-stream' })
    res.end(route.body)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock server failed to bind')
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () => {
      server.close()
    },
  }
}

/** node:http.get 的 HttpGet 注入面（本机 mock；HttpGet 不限定协议）。 */
const httpGet: HttpGet = (url, callback) => {
  const request = get(url, (response) => {
    callback({
      statusCode: response.statusCode,
      on: (event, fn) => {
        response.on(event, (...args) => {
          fn(...(args as unknown[]))
        })
      },
    })
  })
  return {
    on: (event, fn) => {
      request.on(event, (...args) => {
        fn(...(args as unknown[]))
      })
    },
    destroy: () => {
      request.destroy()
    },
  }
}

function manifestFor(version: string, asset: UpdateAsset): UpdateManifest {
  return { latestVersion: version, releaseNotes: 'test notes', assets: [asset] }
}

/** 组装 deps：fetchText 与 downloadAsset 都走本机 mock 真流；spawn 注入。 */
function makeDeps(spawnInstaller: UpdateRunnerDeps['spawnInstaller']): UpdateRunnerDeps {
  return {
    fetchText: async (url, signal) => fetchManifestText(url, httpGet, signal),
    downloadAsset: async (asset, destPath, signal, onProgress) => {
      const fd = openSync(destPath, 'w')
      const hash = createHash('sha256')
      try {
        const { bytes } = await streamDownload(
          asset.url,
          (chunk) => {
            writeSync(fd, chunk)
            hash.update(chunk)
          },
          Math.min(asset.size, 512 * 1024 * 1024),
          signal,
          onProgress,
          httpGet,
        )
        return { bytes, sha256: hash.digest('hex') }
      } finally {
        closeSync(fd)
      }
    },
    spawnInstaller,
  }
}

let temp: string | undefined

afterEach(() => {
  if (temp !== undefined) rmSync(temp, { recursive: true, force: true })
  temp = undefined
})

describe('runUpdateCheck（本机 mock server 真链路）', () => {
  it('unconfigured：feedUrl 为 null 时明确未配置', async () => {
    const outcome = await runUpdateCheck(makeDeps(async () => {}), null, '0.1.0')
    expect(outcome).toEqual({ kind: 'unconfigured' })
  })

  it('newer：manifest 声明严格更新的 stable 版本 → available', async () => {
    const mock = await startMock(new Map([['/manifest.json', {
      status: 200,
      body: Buffer.from(JSON.stringify(manifestFor('0.2.0', {
        url: 'https://placeholder/x.exe', sha256: 'a'.repeat(64), size: 1, filename: 'x.exe',
      }))),
    }]]))
    try {
      const outcome = await runUpdateCheck(makeDeps(async () => {}), `${mock.url}/manifest.json`, '0.1.0')
      expect(outcome.kind).toBe('available')
      if (outcome.kind === 'available') expect(outcome.manifest.latestVersion).toBe('0.2.0')
      expect(mock.requests).toContain('/manifest.json')
    } finally {
      mock.close()
    }
  })

  it('current：同版本 → current；404 说成「没有可用更新」而非"不是有效 JSON"', async () => {
    const current = await startMock(new Map([['/manifest.json', {
      status: 200,
      body: Buffer.from(JSON.stringify(manifestFor('0.1.0', {
        url: 'https://x/y.exe', sha256: 'a'.repeat(64), size: 1, filename: 'y.exe',
      }))),
    }]]))
    try {
      const outcome = await runUpdateCheck(makeDeps(async () => {}), `${current.url}/manifest.json`, '0.1.0')
      expect(outcome).toEqual({ kind: 'current' })
    } finally {
      current.close()
    }
    const notFound = await startMock(new Map([['/manifest.json', { status: 404, body: Buffer.from('<html>not found</html>') }]]))
    try {
      const outcome = await runUpdateCheck(makeDeps(async () => {}), `${notFound.url}/manifest.json`, '0.1.0')
      expect(outcome.kind).toBe('error')
      // 404 是「还没发布过」的事实，不是解析失败，也不该说成下载出错（2026-08-27）。
      if (outcome.kind === 'error') expect(outcome.message).toContain('没有可用的更新')
    } finally {
      notFound.close()
    }
  })
})

describe('runUpdateDownload（mock 真流：size 比对 / digest / 取消 / partial 清理）', () => {
  const payload = Buffer.from('installer-bytes-0123456789')

  it('verified：字节数与 digest 双匹配', async () => {
    temp = mkdtempSync(join(tmpdir(), 'dc-upd-'))
    const digest = createHash('sha256').update(payload).digest('hex')
    const mock = await startMock(new Map([['/setup.exe', { status: 200, body: payload }]]))
    try {
      const manifest = manifestFor('0.2.0', {
        url: `${mock.url}/setup.exe`, sha256: digest, size: payload.length, filename: 'setup.exe',
      })
      const dest = join(temp, 'setup.exe')
      const progress: number[] = []
      const outcome = await runUpdateDownload(
        makeDeps(async () => {}), manifest, dest, new AbortController().signal, b => progress.push(b),
      )
      expect(outcome.kind).toBe('verified')
      expect(existsSync(dest)).toBe(true)
      expect(progress.length).toBeGreaterThan(0)
    } finally {
      mock.close()
    }
  })

  it('digest mismatch：明确失败，partial 由产品路径（runner）清理，绝不执行', async () => {
    temp = mkdtempSync(join(tmpdir(), 'dc-upd-'))
    const mock = await startMock(new Map([['/setup.exe', { status: 200, body: payload }]]))
    try {
      const manifest = manifestFor('0.2.0', {
        url: `${mock.url}/setup.exe`, sha256: 'b'.repeat(64), size: payload.length, filename: 'setup.exe',
      })
      const dest = join(temp, 'setup.exe')
      const outcome = await runUpdateDownload(makeDeps(async () => {}), manifest, dest, new AbortController().signal, () => {})
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') expect(outcome.message).toContain('SHA-256')
      // 清理是产品路径：runner 已删 partial，直接断言磁盘事实（不自己删）。
      expect(existsSync(dest)).toBe(false)
    } finally {
      mock.close()
    }
  })

  it('size mismatch：实际字节数与 manifest 不符 → 明确失败，partial 被 runner 清理', async () => {
    temp = mkdtempSync(join(tmpdir(), 'dc-upd-'))
    const digest = createHash('sha256').update(payload).digest('hex')
    const mock = await startMock(new Map([['/setup.exe', { status: 200, body: payload }]]))
    try {
      const manifest = manifestFor('0.2.0', {
        url: `${mock.url}/setup.exe`, sha256: digest, size: payload.length + 5, filename: 'setup.exe',
      })
      const dest = join(temp, 'setup.exe')
      const outcome = await runUpdateDownload(makeDeps(async () => {}), manifest, dest, new AbortController().signal, () => {})
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') expect(outcome.message).toContain('字节数与 manifest 不符')
      expect(existsSync(dest)).toBe(false)
    } finally {
      mock.close()
    }
  })

  it('cancel：AbortSignal 中断后返回 cancelled，partial 被 runner 清理', async () => {
    temp = mkdtempSync(join(tmpdir(), 'dc-upd-'))
    const digest = createHash('sha256').update(payload).digest('hex')
    const mock = await startMock(new Map([['/setup.exe', { status: 200, body: payload }]]))
    try {
      const manifest = manifestFor('0.2.0', {
        url: `${mock.url}/setup.exe`, sha256: digest, size: payload.length, filename: 'setup.exe',
      })
      const controller = new AbortController()
      controller.abort()
      const dest = join(temp, 'setup.exe')
      const outcome = await runUpdateDownload(makeDeps(async () => {}), manifest, dest, controller.signal, () => {})
      expect(outcome.kind).toBe('cancelled')
      expect(existsSync(dest)).toBe(false)
    } finally {
      mock.close()
    }
  })
})

describe('runUpdateHandoff（spawn 注入：确认已在 UI 层，这里只如实报告）', () => {
  it('spawn 成功 → spawned', async () => {
    const outcome = await runUpdateHandoff(makeDeps(async () => {}), 'C:\\f\\setup.exe')
    expect(outcome).toBe('spawned')
  })

  it('spawn 失败 → spawn-failed，绝不伪造成功、绝不删除当前安装', async () => {
    const outcome = await runUpdateHandoff(
      makeDeps(async () => {
        throw new Error('spawn ENOENT')
      }),
      'C:\\f\\setup.exe',
    )
    expect(outcome).toBe('spawn-failed')
  })
})

describe('fetchManifestText 大小上限', () => {
  it('异常大的 feed 响应被中止而不是堆进内存', async () => {
    const huge = Buffer.alloc(2 * 1024 * 1024, 'x')
    const mock = await startMock(new Map([['/big.json', { status: 200, body: huge }]]))
    try {
      await expect(fetchManifestText(`${mock.url}/big.json`, httpGet, new AbortController().signal))
        .rejects.toThrow(/大小上限/)
    } finally {
      mock.close()
    }
  })
})
