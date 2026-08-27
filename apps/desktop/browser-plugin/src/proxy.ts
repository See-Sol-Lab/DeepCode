/**
 * Local SSRF proxy — the enforcement point of the navigation gate.
 *
 * The browser context is forced through this loopback proxy. Every request
 * (including every redirect hop, which the browser re-issues through the
 * proxy) runs `validateNavigationTarget` first; on pass, the proxy connects
 * to the CHECKED IP with the original Host header, so the browser never
 * resolves DNS itself and a DNS-rebinding attempt cannot reach a private
 * address. HTTPS goes through a CONNECT tunnel (TCP-only, no MITM: the
 * browser's TLS handshake passes through untouched).
 *
 * Only loopback-bound; no credentials; no request body inspection beyond URL.
 *
 * @module @see-sol-lab/deepseekgui-browser/proxy
 */

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect as netConnect, isIP, type LookupFunction } from 'node:net'
import type { Duplex } from 'node:stream'
import type { HostLookup } from './ssrf.ts'
import { validateNavigationTarget } from './ssrf.ts'

/** CONNECT tunnels are only permitted for TLS (and thus only 443). */
const ALLOWED_CONNECT_PORTS = new Set([443])

/**
 * A resolver that always answers with the one address the SSRF check already
 * cleared, whatever it is asked.
 *
 * This is what actually pins the connection. Passing the IP as `host` looks
 * equivalent but is not: it makes the IP the HTTP authority, and it leaves the
 * door open for a global agent (Node 24 honours `NODE_USE_ENV_PROXY` and
 * `HTTP_PROXY`) to re-resolve the real hostname somewhere outside the check.
 * With a pinned lookup the authority stays honest AND the socket can only land
 * on the address we vetted.
 * @param ip - the address {@link validateNavigationTarget} approved.
 * @returns a lookup function usable as `http.request({ lookup })`.
 */
export function pinnedLookup(ip: string): LookupFunction {
  const family = isIP(ip) === 6 ? 6 : 4
  return ((_hostname: string, options: unknown, callback: unknown): void => {
    // Node expects an array when `options.all` is set and a bare address
    // otherwise; answering in the wrong shape breaks the request outright.
    const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true
    const done = callback as (
      error: NodeJS.ErrnoException | null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void
    if (all) done(null, [{ address: ip, family }])
    else done(null, ip, family)
  }) as unknown as LookupFunction
}

/**
 * Split a CONNECT authority into host and port, IPv6 literals included.
 *
 * `split(':')` cannot do this: `[2001:db8::1]:443` carries colons inside the
 * host, so the old parser handed back `[2001` and a NaN port, and every IPv6
 * tunnel died at the gate.
 * @param target - the raw CONNECT request target.
 * @returns host (unbracketed) and port, or null when malformed.
 */
export function parseConnectAuthority(target: string | undefined): { host: string; port: number } | null {
  const raw = (target ?? '').trim()
  if (raw === '') return null
  if (raw.startsWith('[')) {
    // Bracketed form: [addr]:port. Split on the closing bracket rather than
    // on colons, which the address itself is full of.
    const close = raw.indexOf(']:')
    if (close === -1) return null
    const host = raw.slice(1, close)
    const port = Number(raw.slice(close + 2))
    return isIP(host) === 6 && Number.isInteger(port) ? { host, port } : null
  }
  const lastColon = raw.lastIndexOf(':')
  if (lastColon <= 0) return null
  const host = raw.slice(0, lastColon)
  const port = Number(raw.slice(lastColon + 1))
  // A bare IPv6 literal without brackets is not a valid authority: its own
  // colons are indistinguishable from the port separator.
  if (host === '' || host.includes(':') || !Number.isInteger(port)) return null
  return { host, port }
}

/** Wrap an IPv6 address back in brackets so it can be put into a URL. */
function toUrlAuthority(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host
}

/** A running SSRF proxy. */
export interface SsrfProxy {
  /** The loopback port browsers must route through. */
  port: number
  /** Stop accepting connections and release the port. */
  close(): Promise<void>
}

/** Human-safe error body shown in the browser for blocked targets. */
function blockedPage(detail: string): string {
  return [
    '<!doctype html><html><body style="font-family:system-ui;padding:24px">',
    '<h2>Navigation blocked</h2>',
    `<p>${escapeHtml(detail)}</p>`,
    '<p>The DeepSeekGUI browser refuses targets that resolve to local, private, or reserved networks.</p>',
    '</body></html>',
  ].join('')
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!)
}

/**
 * Start the loopback SSRF proxy. Each proxied request validates its URL
 * through {@link validateNavigationTarget} and forwards to the checked IP.
 * @param lookup - DNS injection (the proxy resolves, never the browser).
 * @returns the running proxy handle.
 */
export function startSsrfProxy(lookup: HostLookup): Promise<SsrfProxy> {
  // Every socket the proxy is holding. `server.close()` only stops accepting
  // new connections — it then waits for the existing ones, and a CONNECT
  // tunnel can stay open for as long as the page wants. Without this set,
  // closing the browser could hang on a socket nobody is watching.
  const sockets = new Set<Duplex>()
  const track = (socket: Duplex): void => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
  }

  const server = createServer((request, response) => {
    // The handler is async, so a rejection here would be an unhandled one and
    // the browser would sit waiting for a response that never comes.
    void handlePlainRequest(request, response, lookup).catch(() => {
      if (response.destroyed) response.destroy()
      else response.writeHead(502).end('proxy error')
    })
  })
  server.on('connection', (socket) => { track(socket) })
  server.on('connect', (request, clientSocket, head) => {
    // An upgraded socket is detached from the server's own bookkeeping, so it
    // has to be tracked here too or close() will never see it.
    track(clientSocket)
    void handleConnect(request.url, clientSocket, head, lookup).catch(() => {
      clientSocket.destroy()
    })
  })

  return new Promise((resolve, reject) => {
    // A listen failure (port exhaustion, permissions) arrives as an 'error'
    // event. With nobody listening for it the startup promise never settled
    // and never rejected — the pane just hung.
    const onStartupError = (error: Error): void => {
      reject(new Error(`ssrf proxy failed to start: ${error.message}`))
    }
    server.once('error', onStartupError)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onStartupError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        // Throwing inside this callback would escape the promise entirely.
        server.close()
        reject(new Error('ssrf proxy: unexpected address shape'))
        return
      }
      resolve({
        port: address.port,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy()
          sockets.clear()
          server.close(() => { done() })
        }),
      })
    })
  })
}

/** Plain HTTP: validate, then forward to the checked IP with the original Host. */
async function handlePlainRequest(
  request: IncomingMessage,
  response: ServerResponse,
  lookup: HostLookup,
): Promise<void> {
  if (request.url === undefined) {
    response.writeHead(400).end('bad request')
    return
  }
  // A proxy receives the request-target in ABSOLUTE form (RFC 7230 §5.3.2):
  // `GET http://host/path HTTP/1.1`. Only a client that ignores proxy rules
  // sends origin-form, and only then does the Host header complete it.
  // Concatenating Host + url unconditionally (the previous shape) produced
  // `http://hosthttp://host/path`: with a port it threw in `new URL`, without
  // one it resolved a garbage `hosthttp` hostname — every plain-HTTP
  // navigation through the pane 502'd, and only HTTPS (the CONNECT path)
  // worked.
  const absolute = /^https?:\/\//i.test(request.url)
    ? request.url
    : `http://${request.headers.host ?? 'invalid'}${request.url}`
  const verdict = await validateNavigationTarget(absolute, lookup)
  if (!verdict.ok) {
    response.writeHead(502, { 'content-type': 'text/html; charset=utf-8' })
    response.end(blockedPage(verdict.detail))
    return
  }
  const target = verdict.ips[0]
  if (target === undefined) {
    response.writeHead(502).end('no address')
    return
  }
  let upstreamUrl: URL
  try {
    upstreamUrl = new URL(absolute)
  } catch {
    response.writeHead(502).end('bad target')
    return
  }
  const forwarded = httpRequest({
    // The original hostname stays the HTTP authority; `lookup` below is what
    // decides which address the socket actually reaches.
    host: upstreamUrl.hostname,
    // The target's own port, not a hardcoded 80 — `http://host:8080/` used to
    // be dialled on 80. Port is not the SSRF axis here (the connection always
    // goes to the already-validated IP); the CONNECT path stays 443-only
    // because a raw tunnel is opaque, while this request is one we compose.
    port: upstreamUrl.port === '' ? 80 : Number(upstreamUrl.port),
    method: request.method,
    // Origin-form upstream: we are talking to the origin server, not to
    // another proxy, and many servers reject an absolute-URI target with 400.
    path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
    headers: request.headers,
    // Never inherit the global agent: under Node 24 it honours the ambient
    // proxy env vars and would route this request through a hop we never
    // checked, dissolving the "checked IP == connected IP" guarantee.
    agent: false,
    lookup: pinnedLookup(target),
  }, (upstream) => {
    if (response.destroyed) {
      upstream.destroy()
      return
    }
    response.writeHead(upstream.statusCode ?? 502, upstream.headers)
    upstream.pipe(response)
  })
  forwarded.on('error', () => {
    // 浏览器侧可能已断开（close-to-browser 竞态）：对已销毁的 response
    // 写入会变成 unhandled ECONNABORTED——先查状态，写不动就销毁。
    if (!response.destroyed) {
      response.writeHead(502).end('upstream error')
    } else {
      response.destroy()
    }
  })
  // 浏览器断开时中止转发，避免向上游写已死连接；请求流错误同样吞掉。
  response.on('close', () => { forwarded.destroy() })
  request.on('error', () => { forwarded.destroy() })
  request.pipe(forwarded)
}

/** CONNECT: validate host, then open a raw TCP tunnel to the checked IP:port. */
async function handleConnect(
  target: string | undefined,
  clientSocket: Duplex,
  head: Buffer,
  lookup: HostLookup,
): Promise<void> {
  const authority = parseConnectAuthority(target)
  if (authority === null || !ALLOWED_CONNECT_PORTS.has(authority.port)) {
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    clientSocket.destroy()
    return
  }
  const { host, port } = authority
  const verdict = await validateNavigationTarget(`https://${toUrlAuthority(host)}/`, lookup)
  if (!verdict.ok) {
    clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\nX-DeepSeekGUI-Block: ${escapeHtml(verdict.detail)}\r\n\r\n`)
    clientSocket.destroy()
    return
  }
  const checkedIp = verdict.ips[0]
  if (checkedIp === undefined) {
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    clientSocket.destroy()
    return
  }
  const upstream = netConnect({ host: checkedIp, port })
  upstream.once('connect', () => {
    // 浏览器侧可能在隧道建立前已断开：写入已销毁的 socket 会触发 error。
    if (clientSocket.destroyed) {
      upstream.destroy()
      return
    }
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) upstream.write(head)
    clientSocket.pipe(upstream)
    upstream.pipe(clientSocket)
  })
  // 浏览器断开/网络抖动时写失败会触发 error：无监听即 unhandled。吞掉并销毁。
  clientSocket.on('error', () => { clientSocket.destroy() })
  upstream.once('error', () => {
    if (!clientSocket.destroyed) {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    }
    clientSocket.destroy()
  })
  clientSocket.once('close', () => { upstream.destroy() })
  upstream.once('close', () => { clientSocket.destroy() })
}
