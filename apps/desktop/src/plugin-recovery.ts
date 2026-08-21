/**
 * Plugin Mutation Recovery 的纯逻辑层：DeepCode GUI 发起的插件写操作
 * （add/remove/update/install）的受保护事务。
 *
 * 铁律（P6-F）：
 * - 操作前只对三个白名单文件（package.json / pnpm-lock.yaml /
 *   pnpm-workspace.yaml）做 byte-identical 快照 + hash；文件不存在记录
 *   absent，绝不伪造空文件；绝不备份 node_modules、绝不备份整个 Profile。
 * - journal 只存在 DeepCode userData，绝不进入目标 Profile。
 * - 正常写路径仍只走官方 `dsh plugin`；恢复只在"DeepCode 自己发起、
 *   自己记录、hash 能证明归属"的失败事务上恢复这三个白名单文件。
 * - 同 Home/Profile 同时最多一个 pending unverified transaction。
 * - post-operation 后任一白名单文件发生 hash drift：禁止自动覆盖，
 *   进入人工恢复（fail closed）。
 * 纯 Node 模块，不依赖 Electron，便于单元测试。
 * @module @see-sol-lab/deepcode/plugin-recovery
 */

import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginAction } from './plugin-service.ts'

/** 受保护事务的三个白名单文件（顺序即展示顺序）。 */
export const RECOVERY_WHITELIST = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'] as const

/** 一个白名单文件的快照事实。 */
export interface RecoveryFileFact {
  /** 快照时文件是否存在。 */
  present: boolean
  /** 内容 SHA-256 hex；absent 时为 null。 */
  sha256: string | null
}

/** 全部白名单文件的事实表。 */
export type RecoveryFacts = Record<string, RecoveryFileFact>

/** journal 状态机：唯一 pending 状态是 pending-verification / recovery-needed / drift / running。 */
export type RecoveryJournalState =
  | 'running'
  | 'pending-verification'
  | 'verified'
  | 'recovery-needed'
  | 'drift'
  | 'recovered'
  | 'abandoned'

/** recovery journal 的内容（schemaVersion 1）。 */
export interface PluginRecoveryJournal {
  readonly schemaVersion: 1
  /** 事务 id（快照目录名）。 */
  readonly txId: string
  /** 目标 Home kind。 */
  readonly homeKind: 'managed' | 'existing'
  /** 目标 Home 绝对路径。 */
  readonly homePath: string
  /** 目标 Profile 名。 */
  readonly profile: string
  /** 操作动作。 */
  readonly operation: PluginAction
  /** 操作 spec 的安全描述（已经过请求校验；绝不存凭据/环境变量）。 */
  readonly spec: string | null
  readonly startedAt: string
  /** 操作前白名单事实（present/absent + hash）。 */
  readonly preFacts: RecoveryFacts
  /** 操作后（post-check 成功时）白名单 hash；null = 尚未记录。 */
  readonly postHashes: Record<string, string | null> | null
  readonly state: RecoveryJournalState
  /** 最近一次失败/漂移的脱敏摘要；null = 无。 */
  readonly failure: string | null
  /** 最近一次状态迁移时间。 */
  readonly updatedAt: string
  /** 是否已执行过一次自动恢复（Managed Home 最多一次自动重启）。 */
  readonly autoRecoveredOnce: boolean
}

/** journal 文件名（位于 userData/plugin-recovery/ 下）。 */
export const RECOVERY_JOURNAL_FILENAME = 'journal.json'

/** recovery 目录名（userData 下）。 */
export const RECOVERY_DIRNAME = 'plugin-recovery'

/** 快照目录名（recovery 目录下）。 */
export const RECOVERY_SNAPSHOTS_DIRNAME = 'snapshots'

/**
 * 计算 buffer 的 SHA-256 hex。
 * @param data - 字节内容。
 * @returns 64 位 hex。
 */
export function sha256Of(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * 白名单文件读取失败（**不是**"文件不存在"）。调用方必须 fail closed：
 * 读不到就不知道那里原本是什么，事务的归属证明无从谈起。
 */
export class RecoveryFactsError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(message)
    this.name = 'RecoveryFactsError'
  }
}

/**
 * 从磁盘读取三个白名单文件的当前事实（present/absent + hash）。
 *
 * **"不存在"与"读不到"是两个事实，绝不合并。** 只有 ENOENT 才记 absent；
 * 权限拒绝、文件被锁、IO 错误一律抛 {@link RecoveryFactsError}。早先这里
 * 把任何失败都记成 absent，那会让一个真实存在、只是当时读不到的文件在
 * journal 里留下"操作前它不存在"的假事实——后续恢复据此认为该文件是本
 * 事务产物，从而删掉用户本来就有的东西。
 *
 * 不再先 existsSync 再 readFileSync：两次系统调用之间文件可能被创建或
 * 删除，直接读、按 ENOENT 判断没有这个缝隙。
 * @param profileDir - 目标 Profile 目录。
 * @returns 白名单事实表。
 * @throws {RecoveryFactsError} 任一文件存在但读取失败。
 */
export function readWhitelistFacts(profileDir: string): RecoveryFacts {
  const facts: RecoveryFacts = {}
  for (const name of RECOVERY_WHITELIST) {
    const path = join(profileDir, name)
    try {
      facts[name] = { present: true, sha256: sha256Of(readFileSync(path)) }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        facts[name] = { present: false, sha256: null }
        continue
      }
      throw new RecoveryFactsError(
        name,
        `${name} 存在但无法读取（${code ?? 'unknown'}）：${String(error instanceof Error ? error.message : error)}`,
      )
    }
  }
  return facts
}

/**
 * 把 byte-identical 快照落进快照目录：present 的文件原样复制为
 * `<name>.bak`；absent 的记录留在 journal 事实里，不伪造空文件。
 * @param profileDir - 目标 Profile 目录。
 * @param facts - 快照事实。
 * @param snapshotDir - 快照目录（由调用方创建）。
 * @returns 已落盘的快照文件名列表。
 */
export function writeWhitelistSnapshot(profileDir: string, facts: RecoveryFacts, snapshotDir: string): string[] {
  const written: string[] = []
  for (const name of RECOVERY_WHITELIST) {
    const fact = facts[name]
    if (fact === undefined || !fact.present) continue
    copyFileSync(join(profileDir, name), join(snapshotDir, `${name}.bak`))
    written.push(name)
  }
  return written
}

/**
 * 检查 post-operation 后的 hash 是否发生 drift：任一白名单文件的当前
 * hash 与记录值不一致（包括 present/absent 形态变化）都算 drift。
 * @param recorded - journal 记录的 post hash 表。
 * @param current - 当前磁盘 hash 表。
 * @returns 发生变化的文件名列表（空 = 无 drift）。
 */
export function detectDrift(
  recorded: Record<string, string | null>,
  current: RecoveryFacts,
): string[] {
  const drifted: string[] = []
  for (const name of RECOVERY_WHITELIST) {
    const before = recorded[name] ?? null
    const after = current[name]?.sha256 ?? null
    if (before !== after) drifted.push(name)
  }
  return drifted
}

/**
 * 恢复计划：对照 pre-operation 事实，逐文件决定"恢复"（用快照覆盖）
 * 或"删除"（pre 为 absent、post 才出现、hash 可证明归属时）。
 * pre 为 absent 的文件只在**当前 hash 与 journal 记录的 post hash 一致**
 * 时才允许删除——不能证明归属绝不删除。
 * @param preFacts - pre-operation 事实。
 * @param postHashes - post-check 时记录的 hash。
 * @param current - 当前磁盘事实。
 * @returns 计划：restore = 快照文件名（不含 .bak 后缀）；delete = 要删除的文件名。
 */
export function planRestore(
  preFacts: RecoveryFacts,
  postHashes: Record<string, string | null>,
  current: RecoveryFacts,
): { restore: string[]; remove: string[] } {
  const restore: string[] = []
  const remove: string[] = []
  for (const name of RECOVERY_WHITELIST) {
    const pre = preFacts[name]
    const post = postHashes[name] ?? null
    const now = current[name]?.sha256 ?? null
    if (pre !== undefined && pre.present) {
      restore.push(name)
      continue
    }
    if (pre !== undefined && !pre.present) {
      // pre 为 absent：当前文件必须是本事务产生的（hash 与 post 记录一致）。
      if (now !== null && post !== null && now === post) {
        remove.push(name)
      }
    }
  }
  return { restore, remove }
}

/**
 * boot 健康结算时 journal 的处置判定（settle 的纯逻辑核心，验收返工
 * 抓到的两条语义 bug 都由它钉死）：
 * - `pending-verification` → `verify`：下一代 Host/Web/Client 全部健康，
 *   事务验证完成；
 * - `running` → `resolve-stale`：post-check 从未完成。在途操作由调用方
 *   以 in-flight 检查排除；崩溃残留按"事务不成立"清理（与取消路径同
 *   语义），否则残留会永久卡住单事务规则；
 * - `recovery-needed` / `drift` → `keep`：人工处理状态，boot 成功不自动
 *   解除（Existing 的确认、drift 的人工处理不因重启而消失）。
 * @param state - journal 状态。
 * @returns 结算动作。
 */
export type BootHealthySettleAction = 'verify' | 'resolve-stale' | 'keep'

export function bootHealthySettleAction(state: RecoveryJournalState): BootHealthySettleAction {
  switch (state) {
    case 'pending-verification': return 'verify'
    case 'running': return 'resolve-stale'
    default: return 'keep'
  }
}

/**
 * 人工恢复入口的 fail-closed 构造：post-operation hash 缺失（事务在
 * post-check 记录 hash 之前中断/崩溃，journal 停在 running 后被 settle
 * 置为 recovery-needed）时，恢复计划的归属证明不成立——返回 null，调用方
 * 必须停止恢复并保留人工入口（打开 Profile 文件夹/终端）。
 * 绝不能以空 hash 表降级调用 {@link planRestore}：那会把 pre-present
 * 文件照快照写回，等同于在无法证明归属的情况下改写用户 Profile。
 * @param preFacts - pre-operation 事实。
 * @param postHashes - journal 记录的 post hash（null = 尚未记录）。
 * @param current - 当前磁盘事实。
 * @returns 恢复计划；postHashes 为 null 时返回 null（拒绝恢复）。
 */
export function recoveryPlan(
  preFacts: RecoveryFacts,
  postHashes: Record<string, string | null> | null,
  current: RecoveryFacts,
): { restore: string[]; remove: string[] } | null {
  if (postHashes === null) return null
  return planRestore(preFacts, postHashes, current)
}

/**
 * 执行恢复：restore 用快照 byte-identical 覆盖；remove 只删计划内文件。
 * 不碰 node_modules、不碰快照目录本身。
 *
 * 写入前先把全部快照读进内存：任一快照缺失/不可读就整体拒绝，一个字节
 * 都不落盘。半恢复（package.json 已回滚、pnpm-lock.yaml 还是新的）比完全
 * 不恢复更糟——那是一个两边都不自洽的 Profile，而调用方的失败提示只会
 * 说"恢复失败"，用户不会知道磁盘已被改过一半。
 * @param profileDir - 目标 Profile 目录。
 * @param snapshotDir - 快照目录。
 * @param plan - {@link planRestore} 的产出。
 * @param write - 覆盖写盘（restore 用快照内容写回，注入面便于测试）。
 * @param removeFile - 删除文件（注入面）。
 */
export function applyRestore(
  profileDir: string,
  snapshotDir: string,
  plan: { restore: string[]; remove: string[] },
  write: (path: string, content: Buffer) => void,
  removeFile: (path: string) => void,
): void {
  const contents: { path: string; content: Buffer }[] = []
  for (const name of plan.restore) {
    const backup = join(snapshotDir, `${name}.bak`)
    let content: Buffer
    try {
      content = readFileSync(backup)
    } catch (error) {
      throw new Error(
        `恢复快照不可用（${name}.bak）：${String(error instanceof Error ? error.message : error)}；`
        + '为避免半恢复状态，本次恢复未写入任何文件',
      )
    }
    contents.push({ path: join(profileDir, name), content })
  }
  for (const entry of contents) {
    write(entry.path, entry.content)
  }
  for (const name of plan.remove) {
    removeFile(join(profileDir, name))
  }
}

/** 是否为合法 journal 状态。 */
export function isRecoveryJournalState(value: unknown): value is RecoveryJournalState {
  return value === 'running' || value === 'pending-verification' || value === 'verified'
    || value === 'recovery-needed' || value === 'drift' || value === 'recovered' || value === 'abandoned'
}

/** 是否为普通对象（非 null、非数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 严格解析一个文件事实。 */
function parseFact(raw: unknown, where: string): RecoveryFileFact {
  if (!isRecord(raw)) throw new Error(`${where}: 必须是对象`)
  const { present, sha256 } = raw
  if (typeof present !== 'boolean') throw new Error(`${where}.present: 必须是布尔值`)
  if (sha256 !== null && (typeof sha256 !== 'string' || sha256.length === 0)) {
    throw new Error(`${where}.sha256: 必须是字符串或 null`)
  }
  if (present && sha256 === null) throw new Error(`${where}: present 的文件必须有 sha256`)
  if (!present && sha256 !== null) throw new Error(`${where}: absent 的文件 sha256 必须是 null`)
  return { present, sha256 }
}

/** 严格解析白名单事实表（键必须是白名单文件）。 */
function parseFacts(raw: unknown, where: string): RecoveryFacts {
  if (!isRecord(raw)) throw new Error(`${where}: 必须是对象`)
  const facts: RecoveryFacts = {}
  for (const name of RECOVERY_WHITELIST) {
    if (raw[name] !== undefined) facts[name] = parseFact(raw[name], `${where}.${name}`)
  }
  return facts
}

/** 严格解析 hash 表。 */
function parseHashes(raw: unknown, where: string): Record<string, string | null> {
  if (!isRecord(raw)) throw new Error(`${where}: 必须是对象`)
  const hashes: Record<string, string | null> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (!(RECOVERY_WHITELIST as readonly string[]).includes(name)) continue
    if (value !== null && typeof value !== 'string') throw new Error(`${where}.${name}: 必须是字符串或 null`)
    hashes[name] = value
  }
  return hashes
}

/**
 * 严格解析 journal 文本。任何 JSON/schema 问题抛错（调用方按损坏处理，
 * 绝不静默猜测——journal 是恢复归属的证明）。
 * @param content - journal 文本。
 * @returns journal。
 */
export function parseRecoveryJournal(content: string): PluginRecoveryJournal {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch (error) {
    throw new Error(`recovery journal 不是有效 JSON: ${String(error instanceof Error ? error.message : error)}`)
  }
  if (!isRecord(raw)) throw new Error('recovery journal 顶层必须是对象')
  if (raw.schemaVersion !== 1) throw new Error(`recovery journal schemaVersion 未知: ${JSON.stringify(raw.schemaVersion)}`)
  if (typeof raw.txId !== 'string' || raw.txId.length === 0) throw new Error('txId 缺失')
  if (raw.homeKind !== 'managed' && raw.homeKind !== 'existing') throw new Error('homeKind 非法')
  if (typeof raw.homePath !== 'string' || raw.homePath.length === 0) throw new Error('homePath 缺失')
  if (typeof raw.profile !== 'string' || raw.profile.length === 0) throw new Error('profile 缺失')
  if (raw.operation !== 'add' && raw.operation !== 'remove' && raw.operation !== 'update' && raw.operation !== 'install') {
    throw new Error('operation 非法')
  }
  if (raw.spec !== null && typeof raw.spec !== 'string') throw new Error('spec 必须是字符串或 null')
  if (typeof raw.startedAt !== 'string' || raw.startedAt.length === 0) throw new Error('startedAt 缺失')
  if (!isRecoveryJournalState(raw.state)) throw new Error(`state 未知: ${JSON.stringify(raw.state)}`)
  if (raw.failure !== null && typeof raw.failure !== 'string') throw new Error('failure 必须是字符串或 null')
  if (typeof raw.updatedAt !== 'string' || raw.updatedAt.length === 0) throw new Error('updatedAt 缺失')
  if (typeof raw.autoRecoveredOnce !== 'boolean') throw new Error('autoRecoveredOnce 必须是布尔值')
  return {
    schemaVersion: 1,
    txId: raw.txId,
    homeKind: raw.homeKind,
    homePath: raw.homePath,
    profile: raw.profile,
    operation: raw.operation,
    spec: raw.spec,
    startedAt: raw.startedAt,
    preFacts: parseFacts(raw.preFacts, 'preFacts'),
    postHashes: raw.postHashes === null ? null : parseHashes(raw.postHashes, 'postHashes'),
    state: raw.state,
    failure: raw.failure,
    updatedAt: raw.updatedAt,
    autoRecoveredOnce: raw.autoRecoveredOnce,
  }
}

/** 序列化 journal（稳定键序，结尾一个换行）。 */
export function serializeRecoveryJournal(journal: PluginRecoveryJournal): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    txId: journal.txId,
    homeKind: journal.homeKind,
    homePath: journal.homePath,
    profile: journal.profile,
    operation: journal.operation,
    spec: journal.spec,
    startedAt: journal.startedAt,
    preFacts: journal.preFacts,
    postHashes: journal.postHashes,
    state: journal.state,
    failure: journal.failure,
    updatedAt: journal.updatedAt,
    autoRecoveredOnce: journal.autoRecoveredOnce,
  }, null, 2)}\n`
}

/**
 * 判断 journal 是否处于"未验证待处理"状态（单事务规则与恢复检查的对象）。
 * @param journal - journal。
 * @returns pending 状态为 true。
 */
export function isJournalPending(journal: PluginRecoveryJournal): boolean {
  return journal.state === 'running' || journal.state === 'pending-verification'
    || journal.state === 'recovery-needed' || journal.state === 'drift'
}
