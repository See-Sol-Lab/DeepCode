/**
 * SSRF-safe navigation gate for the DeepCode browser capability.
 *
 * Pure, network-free half: URL hygiene, IP classification, and the
 * resolve-then-check decision every navigation target must pass BEFORE any
 * network byte moves. The proxy layer (browser-proxy.ts) is the enforcement
 * point: it resolves through this module, connects to the checked IP, and
 * re-checks every redirect hop. No localhost/private/link-local/metadata
 * target is ever reachable — including DeepCode's own 3080/control bridge,
 * which is a feature, not an exception (菲博 §7.1.5).
 *
 * @module @see-sol-lab/deepcode-browser/ssrf
 */

/** A blocked target classification, for machine-readable reasons. */
export type BlockReason =
  | 'unsupported-scheme'
  | 'url-too-long'
  | 'credentials-in-url'
  | 'invalid-host'
  | 'blocked-ip'

/** Result of one navigation-target validation. */
export type TargetVerdict =
  | { ok: true; host: string; ips: readonly string[] }
  | { ok: false; reason: BlockReason; detail: string }

/** DNS lookup injection (tests mock it; the proxy uses node:dns). */
export interface HostLookup {
  lookup(host: string): Promise<readonly string[]>
}

/** Inclusive CIDR check over a parsed 32-bit IPv4 address. */
function ipv4InCidr(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  return (value & mask) === (base & mask)
}

/** Parse a dotted-quad IPv4 string into its 32-bit form; NaN on failure. */
export function parseIpv4(text: string): number {
  const parts = text.split('.')
  if (parts.length !== 4) return Number.NaN
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN
    const octet = Number(part)
    if (octet > 255) return Number.NaN
    value = (value << 8) | octet
  }
  return value >>> 0
}

/**
 * Whether an IPv4 address is a SSRF-relevant block: loopback, private,
 * CGNAT, link-local (incl. cloud metadata 169.254.169.254), documentation,
 * benchmarking, multicast, reserved. Everything else is treated as public.
 * @param value - parsed 32-bit IPv4.
 * @returns true when the address must never be connected to.
 */
export function isBlockedIpv4(value: number): boolean {
  return ipv4InCidr(value, 0x0000_0000, 8) // 0.0.0.0/8 — "this network"
    || ipv4InCidr(value, 0x0a00_0000, 8) // 10.0.0.0/8 — private
    || ipv4InCidr(value, 0x6440_0000, 10) // 100.64.0.0/10 — CGNAT
    || ipv4InCidr(value, 0x7f00_0000, 8) // 127.0.0.0/8 — loopback
    || ipv4InCidr(value, 0xa9fe_0000, 16) // 169.254.0.0/16 — link-local + metadata
    || ipv4InCidr(value, 0xac10_0000, 12) // 172.16.0.0/12 — private
    || ipv4InCidr(value, 0xc000_0000, 24) // 192.0.0.0/24 — IETF protocol
    || ipv4InCidr(value, 0xc000_0200, 24) // 192.0.2.0/24 — documentation
    || ipv4InCidr(value, 0xc0a8_0000, 16) // 192.168.0.0/16 — private
    || ipv4InCidr(value, 0xc612_0000, 15) // 198.18.0.0/15 — benchmarking
    || ipv4InCidr(value, 0xc633_6400, 24) // 198.51.100.0/24 — documentation
    || ipv4InCidr(value, 0xcb00_7100, 24) // 203.0.113.0/24 — documentation
    || ipv4InCidr(value, 0xe000_0000, 4) // 224.0.0.0/4 — multicast
    || ipv4InCidr(value, 0xf000_0000, 4) // 240.0.0.0/4 — reserved
}

/**
 * Parse an IPv6 literal into its eight 16-bit groups.
 *
 * Text-prefix matching is not enough for this family: `::1` also spells as
 * `0:0:0:0:0:0:0:1`, and an IPv4-mapped address spells both `::ffff:127.0.0.1`
 * and `::ffff:7f00:1`. Anything that cannot be parsed here is refused by the
 * caller — an address we cannot classify must never be connected to.
 * @param text - the literal address (an optional %zone is ignored).
 * @returns eight groups, or null when unparseable.
 */
export function parseIpv6(text: string): number[] | null {
  let input = text.trim().toLowerCase()
  const zone = input.indexOf('%')
  if (zone >= 0) input = input.slice(0, zone)
  if (input.length === 0) return null
  // A trailing dotted quad (::ffff:127.0.0.1) is two more hex groups.
  const lastColon = input.lastIndexOf(':')
  if (lastColon >= 0 && input.slice(lastColon + 1).includes('.')) {
    const embedded = parseIpv4(input.slice(lastColon + 1))
    if (Number.isNaN(embedded)) return null
    const high = ((embedded >>> 16) & 0xffff).toString(16)
    const low = (embedded & 0xffff).toString(16)
    input = `${input.slice(0, lastColon + 1)}${high}:${low}`
  }
  const halves = input.split('::')
  if (halves.length > 2) return null
  const headText = halves[0] ?? ''
  const tailText = halves.length === 2 ? halves[1] ?? '' : ''
  const head = headText === '' ? [] : headText.split(':')
  const tail = tailText === '' ? [] : tailText.split(':')
  const groups = halves.length === 2
    ? [...head, ...new Array<string>(8 - head.length - tail.length).fill('0'), ...tail]
    : head
  if (groups.length !== 8) return null
  const parsed: number[] = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    parsed.push(Number.parseInt(group, 16))
  }
  return parsed
}

/**
 * Whether a literal IPv6 address is SSRF-relevant. Unparseable input is
 * blocked (fail closed) — the IPv4 side has always behaved that way, and an
 * address we cannot classify is exactly the one not to dial.
 * @param text - literal IPv6 address.
 * @returns true when the address must never be connected to.
 */
export function isBlockedIpv6(text: string): boolean {
  const groups = parseIpv6(text)
  if (groups === null) return true
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups
  // ::ffff:0:0/96 (IPv4-mapped) and ::/96 (IPv4-compatible, which also covers
  // :: and ::1) carry an IPv4 — judge them by the IPv4 table.
  const leadingZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0
  if (leadingZero && (g5 === 0xffff || g5 === 0)) {
    return isBlockedIpv4((((g6 << 16) >>> 0) + g7) >>> 0)
  }
  if (g0 === 0x0064 && g1 === 0xff9b) return true // 64:ff9b::/96 — NAT64
  if ((g0 & 0xfe00) === 0xfc00) return true // fc00::/7 — unique local
  if ((g0 & 0xffc0) === 0xfe80) return true // fe80::/10 — link-local
  if ((g0 & 0xffc0) === 0xfec0) return true // fec0::/10 — site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true // ff00::/8 — multicast
  if (g0 === 0x2002) return true // 2002::/16 — 6to4
  if (g0 === 0x2001 && g1 === 0x0000) return true // 2001::/32 — Teredo
  if (g0 === 0x2001 && g1 === 0x0db8) return true // 2001:db8::/32 — documentation
  return false
}

/**
 * Whether a literal IP string (v4 or v6) is SSRF-relevant.
 * @param ip - literal address.
 * @returns true when the address must never be connected to.
 */
export function isBlockedIp(ip: string): boolean {
  if (ip.includes(':')) return isBlockedIpv6(ip)
  const value = parseIpv4(ip)
  return Number.isNaN(value) ? true : isBlockedIpv4(value)
}

/** http(s) only, bounded length, no embedded credentials — the URL hygiene layer. */
export function validateUrlHygiene(input: string, maxLength: number): TargetVerdict {
  if (input.length > maxLength) {
    return { ok: false, reason: 'url-too-long', detail: `URL exceeds the maximum length of ${maxLength}` }
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { ok: false, reason: 'invalid-host', detail: `invalid URL: ${input}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported-scheme', detail: `unsupported URL scheme "${url.protocol}" (only http and https are allowed)` }
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { ok: false, reason: 'credentials-in-url', detail: 'credentials in URLs are not allowed' }
  }
  if (url.hostname.length === 0) {
    return { ok: false, reason: 'invalid-host', detail: 'URL has no host' }
  }
  return { ok: true, host: stripIpv6Brackets(url.hostname), ips: [] }
}

/**
 * WHATWG URL keeps IPv6 literals bracketed (`[::1]`), but every consumer
 * downstream wants the bare address: `dns.lookup('[::1]')` fails outright,
 * so an IPv6 literal used to be refused as an invalid host rather than
 * checked on its merits. Strip the brackets once, here at the hygiene edge.
 * @param hostname - hostname straight off the parsed URL.
 * @returns the hostname without IPv6 brackets.
 */
export function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/**
 * Resolve a host and reject it when ANY resolved address is blocked —
 * the DNS-rebinding first line. A host whose resolution fails entirely is
 * refused (a navigation that cannot be verified must not proceed).
 * @param host - hostname from the hygiene layer.
 * @param lookup - DNS injection (node:dns lookup all with verbatim results).
 * @returns the checked IP list on success.
 */
export async function resolveChecked(host: string, lookup: HostLookup): Promise<TargetVerdict> {
  let ips: readonly string[]
  try {
    ips = await lookup.lookup(host)
  } catch (error) {
    return { ok: false, reason: 'invalid-host', detail: `DNS resolution failed for ${host}: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (ips.length === 0) {
    return { ok: false, reason: 'invalid-host', detail: `DNS resolution returned no addresses for ${host}` }
  }
  const blocked = ips.find(ip => isBlockedIp(ip))
  if (blocked !== undefined) {
    return { ok: false, reason: 'blocked-ip', detail: `host ${host} resolves to a blocked address (${blocked})` }
  }
  return { ok: true, host, ips }
}

/**
 * The complete navigation gate: hygiene → resolve → check. Every navigation
 * (including each redirect hop) runs this before bytes move.
 * @param input - the URL string.
 * @param lookup - DNS injection.
 * @param maxLength - URL length bound.
 * @returns the final verdict with the checked IPs for connect-by-IP.
 */
export async function validateNavigationTarget(
  input: string,
  lookup: HostLookup,
  maxLength = 2048,
): Promise<TargetVerdict> {
  const hygiene = validateUrlHygiene(input, maxLength)
  if (!hygiene.ok) return hygiene
  return resolveChecked(hygiene.host, lookup)
}

/** Default resolver over node:dns (verbatim = do not reorder results). */
export function nodeLookup(host: string): Promise<readonly string[]> {
  return import('node:dns').then(dns =>
    dns.promises.lookup(host, { all: true, verbatim: true }).then(
      entries => entries.map(entry => entry.address),
    ),
  )
}
