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
 * @module @see-sol-lab/deepseekgui/diagnostics-service
 */

import { maskWindowsLiteral } from './redact.ts'
import type { DeepSeekGUIVersionInfo } from './version-info.ts'

/**
 * Build Info 的一行事实（Diagnostics Center 与 Copy Build Info 共用）。
 *
 * 界面与导出文本是**两个受众**，所以一行事实带两套投影：界面给用户看
 * （本地化标签、路径打码），导出文本给维护者看（英文标签、原始值，
 * 语言不随用户界面变，贴进 issue 谁都读得懂）。
 */
export interface BuildInfoLine {
  /** 导出文本用的英文标签，不随界面语言变。 */
  label: string
  /** 界面本地化用的字典键；插件侧取不到时回退 {@link label}。 */
  key: string
  /** 界面显示值（路径已打码）。 */
  value: string
  /** 值本身也需要本地化时的字典键（如 Managed / Existing）。 */
  valueKey?: string
  /** 导出与"复制"用的原值；缺省即 {@link value}。 */
  exportValue?: string
  /** 只进导出文本，不在界面显示。 */
  exportOnly?: boolean
}

/**
 * source commit 缩短到 7 位，保留 `+dirty` 之类的后缀。
 *
 * 40 位全长在面板里会把整行挤走，而 7 位对定位代码完全够用（git 自己的
 * 短号就是这个长度）。后缀必须留：它说明那次构建的工作树不干净，也就是
 * 这个 commit 号**定位不到确切代码**——这正是维护者最需要知道的一件事。
 * @param commit - 原始 commit 描述。
 * @returns 缩短后的描述。
 */
export function shortSourceCommit(commit: string): string {
  if (commit === 'unknown') return commit
  const mark = commit.search(/[+-]/)
  const hash = mark === -1 ? commit : commit.slice(0, mark)
  const suffix = mark === -1 ? '' : commit.slice(mark)
  return `${hash.slice(0, 7)}${suffix}`
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
 * @param lastUpdate - 当前版本装上机器的时间文本（首装即安装时间）。
 * @param maskPath - 界面显示用的路径打码；不传则原样显示（导出路径本就
 * 走 {@link normalizeUserPaths}，这里管的是**面板**上那份）。
 * @returns 有序事实行。
 */
export function buildInfoLines(input: {
  version: DeepSeekGUIVersionInfo
  homeKind: 'managed' | 'existing'
  profile: string
  harnessStatus: string
  logPath: string | null
  updateChannel: string
  lastUpdate: string
  maskPath?: (path: string) => string
}): BuildInfoLine[] {
  const commit = input.version.sourceCommit === null ? 'unknown' : input.version.sourceCommit
  // 界面上的路径打码：用户报 bug 最常见的方式是**截图**，而导出侧的
  // <USER_HOME> 归一化只作用于导出文本，救不了截图。面板显示打码值，
  // 真路径留给"复制完整路径"按钮（line() 的 copy 值走 exportValue）。
  const mask = input.maskPath ?? ((path: string) => path)
  const logPath = input.logPath ?? '(unavailable)'
  return [
    { key: 'diag.build.app', label: 'DeepSeekGUI', value: input.version.appVersion },
    {
      key: 'diag.build.dsh',
      label: 'Embedded DSH',
      value: `${input.version.embeddedDshVersion} (source ${shortSourceCommit(commit)})`,
      exportValue: `${input.version.embeddedDshVersion} (source ${commit})`,
    },
    { key: 'diag.build.runtime', label: 'Electron', value: `${input.version.electronVersion} · ${input.version.platform}-${input.version.arch}` },
    {
      key: 'diag.build.home',
      label: 'Harness Home',
      value: input.homeKind === 'managed' ? 'Managed' : 'Existing',
      valueKey: input.homeKind === 'managed' ? 'harness.home.managed' : 'harness.home.existing',
    },
    { key: 'diag.build.profile', label: 'Active Profile', value: input.profile },
    { key: 'diag.build.status', label: 'Harness Status', value: input.harnessStatus },
    { key: 'diag.build.log', label: 'Diagnostics Log', value: mask(logPath), exportValue: logPath },
    { key: 'diag.build.updated', label: 'Last Update', value: input.lastUpdate },
    // 更新通道是**我们的**发行事实，对用户没有可操作性（住户 2026-08-24：
    // 「这个更新这里可以收掉，不需要整这么详细」）。导出里留着——维护者
    // 排查"为什么收不到更新"时，第一件事就是问用户走的哪个通道。
    { key: 'diag.build.channel', label: 'Update Channel', value: input.updateChannel, exportOnly: true },
  ]
}

/** 把 Build Info 行渲染成多行文本（Copy Build Info / bundle 文件）。 */
export function buildInfoText(lines: BuildInfoLine[]): string {
  return lines.map(line => `${line.label}: ${line.exportValue ?? line.value}`).join('\n')
}

/** 当前版本是什么时候装到这台机器上的（{@link resolveInstallStamp} 的产物）。 */
export interface InstallStamp {
  /** 记录这一笔时正在跑的版本。 */
  version: string
  /** 该版本首次在这台机器上启动的时刻（ISO）。 */
  since: string
}

/**
 * 解析"上次更新时间"。
 *
 * 面板上那一行要回答的是「我这一版是什么时候来的」，而它有两种来历——
 * 全新安装与升级覆盖。**不去区分这两件事**：记录「当前版本第一次跑起来
 * 的时刻」，首装时它就是安装时间，升级后版本变了就刷新成更新时间，一个
 * 字段同时满足两种情形（住户 2026-08-24 定：「如果用户安装以后没更新过
 * 就显示安装时间」）。
 *
 * 为什么不用文件系统时间：NSIS 写入的 exe 往往保留打包时的时间戳（那是
 * 构建时间不是安装时间），而覆盖升级又不会改安装目录的创建时间——两个
 * 都答不对这一行要问的问题。注册表的 InstallDate 在本机实测为空。
 *
 * 版本没变时原样返回已记录的时刻，绝不因为重启就刷新（那会把"上次更新"
 * 变成"上次启动"）。记录损坏或缺失一律当作"这一版刚到"，宁可显示得晚
 * 一点，不显示一个编造的过去时刻。
 * @param raw - 已存记录的原始 JSON 文本；无记录传 null。
 * @param version - 当前应用版本。
 * @param now - 当前时刻（ISO）。
 * @returns 生效的记录，以及是否需要落盘。
 */
export function resolveInstallStamp(
  raw: string | null,
  version: string,
  now: string,
): { stamp: InstallStamp; changed: boolean } {
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw)
      const kept = parsed as Partial<InstallStamp>
      // 只非空是不够的：格式化那一侧遇到解析不了的时刻会返回空串，于是
      // 面板永远显示 unknown，而这条坏记录会被一直原样留着。解析得动才
      // 算数，否则当成"这一版刚到"重写一笔，下次就正常了。
      if (kept.version === version && typeof kept.since === 'string' && Number.isFinite(Date.parse(kept.since))) {
        return { stamp: { version, since: kept.since }, changed: false }
      }
    } catch {
      // 记录损坏：当作这一版刚到，下面重记一笔。
    }
  }
  return { stamp: { version, since: now }, changed: true }
}

/**
 * ISO 时刻 → 本机时区的 `YYYY-MM-DD HH:mm`。
 *
 * 刻意不用 `toLocaleString`：它的输出随系统区域与 ICU 版本变（同一台机器
 * 换个语言就换个格式），面板文案与 e2e 断言都会跟着晃。这个格式中英文
 * 用户都读得懂，也不需要进双语字典。
 * @param iso - ISO 时刻。
 * @returns 可读文本；无法解析时返回空串（调用方据此回退）。
 */
export function formatStampLocal(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * 用户路径归一化：把用户主目录的两种写法归一为 <USER_HOME> 占位，
 * 防导出文本泄露机器路径。占位本身出现在输出前由调用方明确提示。
 * @param text - 原始文本。
 * @param home - 用户主目录绝对路径。
 * @returns 归一化文本。
 */
export function normalizeUserPaths(text: string, home: string): string {
  return maskWindowsLiteral(text, home, '<USER_HOME>')
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
  version: DeepSeekGUIVersionInfo
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
  version: DeepSeekGUIVersionInfo,
  entries: BundleManifestEntry[],
  skipped: BundleSkippedEntry[],
  exportedAt: string,
): string {
  return `${JSON.stringify({
    formatVersion: 2,
    exportedAt,
    deepseekguiVersion: version.appVersion,
    embeddedDshVersion: version.embeddedDshVersion,
    sourceCommit: version.sourceCommit ?? 'unknown',
    files: entries,
    skipped,
  }, null, 2)}\n`
}
