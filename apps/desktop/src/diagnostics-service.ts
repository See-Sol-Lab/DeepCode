/**
 * Diagnostics Center 的纯逻辑层：build info 的 allowlist 事实组装、
 * 用户路径归一化与 diagnostics bundle 的 manifest/文件过滤。
 *
 * 铁律：
 * - bundle 只生成本地文件，绝不上传；
 * - 不包含 credential、.env、session 正文——allowlist 之外的文件一律
 *   不进 bundle，文件名过滤是结构性的（不是事后过滤 secret）；
 * - 日志进入 bundle 前已经过既有 redaction；
 * - 用户 home/path 在导出文本中归一化（<USER_HOME> 占位）。
 * 纯 Node 模块，不依赖 Electron，便于单元测试。
 * @module @see-sol-lab/deepcode/diagnostics-service
 */

import type { DeepCodeVersionInfo } from './version-info.ts'

/** Build Info 的一行事实（Diagnostics Center 与 Copy Build Info 共用）。 */
export interface BuildInfoLine {
  label: string
  value: string
}

/**
 * 组装 Build Info 行（allowlist 事实，全部受控来源；任何凭据、环境
 * 变量、会话内容在结构上不可能进入）。
 * @param version - 四元组版本事实。
 * @param homeKind - active Home kind（绝不含路径）。
 * @param profile - active Profile 名。
 * @param harnessStatus - Harness 七相状态的可读文本。
 * @param logPath - 诊断日志位置（可能缺失）。
 * @param updateChannel - 更新通道描述（unconfigured/URL）。
 * @returns 有序事实行。
 */
export function buildInfoLines(input: {
  version: DeepCodeVersionInfo
  homeKind: 'managed' | 'existing'
  profile: string
  harnessStatus: string
  logPath: string | null
  updateChannel: string
}): BuildInfoLine[] {
  const commit = input.version.sourceCommit === null ? 'unknown' : input.version.sourceCommit
  return [
    { label: 'DeepCode', value: input.version.appVersion },
    { label: 'Embedded DSH', value: `${input.version.embeddedDshVersion} (source ${commit})` },
    { label: 'Electron', value: `${input.version.electronVersion} · ${input.version.platform}-${input.version.arch}` },
    { label: 'Harness Home', value: input.homeKind === 'managed' ? 'Managed' : 'Existing' },
    { label: 'Active Profile', value: input.profile },
    { label: 'Harness Status', value: input.harnessStatus },
    { label: 'Diagnostics Log', value: input.logPath ?? '(unavailable)' },
    { label: 'Update Channel', value: input.updateChannel },
  ]
}

/** 把 Build Info 行渲染成多行文本（Copy Build Info / bundle 文件）。 */
export function buildInfoText(lines: BuildInfoLine[]): string {
  return lines.map(line => `${line.label}: ${line.value}`).join('\n')
}

/**
 * 用户路径归一化：把用户主目录的两种写法归一为 <USER_HOME> 占位，
 * 防导出文本泄露机器路径。占位本身出现在输出前由调用方明确提示。
 * @param text - 原始文本。
 * @param home - 用户主目录绝对路径。
 * @returns 归一化文本。
 */
export function normalizeUserPaths(text: string, home: string): string {
  if (home === '') return text
  const normalized = home.replace(/\\/g, '/')
  const replaced = text.split(home).join('<USER_HOME>')
  return replaced.split(normalized).join('<USER_HOME>')
}

/** diagnostics bundle 的文件名 allowlist：白名单之外的文件结构上不可进入。 */
export function isBundleFileAllowed(filename: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(filename)
    && (/\.log(\.\d+)?$/.test(filename) || filename.endsWith('.txt') || filename.endsWith('.dmp') || filename === 'bundle-manifest.json')
}

/** bundle manifest 的内容事实（版本 + 文件清单，逐文件记录来源与大小）。 */
export interface BundleManifestEntry {
  file: string
  source: string
  bytes: number
}

/** bundle 里一条被跳过证据的记录（如实写入 manifest，绝不伪造全部成功）。 */
export interface BundleSkippedEntry {
  file: string
  reason: string
}
/**
 * 组装 diagnostics bundle 的写入内容（纯函数，main 只负责读写盘）：
 * allowlist 过滤 → 每个文本文件的**正文**过用户路径归一化 → 从过滤后的
 * 文件生成 manifest（manifest 自身也归一化）。二进制证据（crash dump）
 * 原样进入、不做归一化，只记名字与大小。绝不含凭据/.env/session
 * 正文——文件名的结构性 allowlist 在入口就挡掉。
 * @param input - 输入事实。
 * @returns 文件名 → 最终写入内容（文本或二进制，含 bundle-manifest.json）。
 */
export function assembleDiagnosticsBundle(input: {
  /** 用户主目录（归一化基准）。 */
  home: string
  version: DeepCodeVersionInfo
  /** 已脱敏的日志条目（content 经 redaction 后才传入）。 */
  logEntries: { name: string; content: string; source: string }[]
  /** Build Info 文本。 */
  buildInfo: string
  /** 导出时间戳。 */
  exportedAt: string
  /** 二进制证据（crash dump，原样字节进入）。 */
  extraFiles?: { name: string; content: Buffer; source: string }[]
  /** 被总量边界跳过的证据（如实记录）。 */
  skippedEvidence?: { name: string; reason: string }[]
  /** 上次退出状态文本（clean / unclean / unknown）。 */
  lastExit?: string
}): Map<string, string | Buffer> {
  const files = new Map<string, string | Buffer>()
  const entries: BundleManifestEntry[] = []
  const write = (filename: string, content: string, source: string): void => {
    if (!isBundleFileAllowed(filename)) return
    const normalized = normalizeUserPaths(content, input.home)
    files.set(filename, normalized)
    entries.push({
      file: filename,
      source: normalizeUserPaths(source, input.home),
      bytes: Buffer.byteLength(normalized),
    })
  }
  for (const entry of input.logEntries) {
    write(entry.name, entry.content, entry.source)
  }
  if (input.logEntries.length === 0) {
    write('dsh-service.log.unavailable.txt', 'no logs available\n', 'n/a')
  }
  for (const extra of input.extraFiles ?? []) {
    // 二进制证据不做路径归一化：只校验名字 allowlist，字节原样进入。
    if (!isBundleFileAllowed(extra.name)) continue
    files.set(extra.name, extra.content)
    entries.push({
      file: extra.name,
      source: normalizeUserPaths(extra.source, input.home),
      bytes: extra.content.length,
    })
  }
  write('build-info.txt', input.buildInfo, '<generated>')
  if (input.lastExit !== undefined) {
    write('last-exit.txt', `${input.lastExit}\n`, '<generated>')
  }
  const skipped = (input.skippedEvidence ?? []).map(entry => ({ file: entry.name, reason: entry.reason }))
  write('bundle-manifest.json', buildBundleManifest(input.version, entries, skipped, input.exportedAt), '<generated>')
  return files
}

/**
 * 组装 diagnostics bundle manifest（JSON 文本）。只列 allowlist 文件；
 * 每个条目记录来源路径（归一化后）与大小；被跳过的证据如实列出——
 * 导出内容可核对、不含未声明文件。
 * @param version - 四元组版本事实。
 * @param entries - 文件清单。
 * @param skipped - 被跳过证据。
 * @param exportedAt - 导出时间戳文本。
 * @returns manifest JSON 文本。
 */
export function buildBundleManifest(
  version: DeepCodeVersionInfo,
  entries: BundleManifestEntry[],
  skipped: BundleSkippedEntry[],
  exportedAt: string,
): string {
  return `${JSON.stringify({
    formatVersion: 2,
    exportedAt,
    deepcodeVersion: version.appVersion,
    embeddedDshVersion: version.embeddedDshVersion,
    sourceCommit: version.sourceCommit ?? 'unknown',
    files: entries,
    skipped,
  }, null, 2)}\n`
}
