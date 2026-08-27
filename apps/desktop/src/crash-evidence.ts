/**
 * 原生崩溃证据的最小纯函数：active-run / unclean-exit marker 与
 * Crashpad dump 收集计划。
 *
 * 铁律：
 * - marker 只是"上次可能未正常退出"的证据，绝不自动断言是 crash、
 *   绝不因此自动删除用户数据；
 * - dump 收集总量有界（budget），超限时保留最近、最相关证据并在
 *   清单里如实记录被跳过者——绝不伪造"全部导出成功"；
 * - 一切证据只在本机磁盘生成，绝不上传。
 * 纯 Node 模块，不依赖 Electron，便于单元测试。
 * @module @see-sol-lab/deepseekgui/crash-evidence
 */

/** active-run marker 文件名（位于 Electron userData 目录下）。 */
export const ACTIVE_RUN_FILENAME = 'active-run.json'

/** active-run marker 的 schema 版本。 */
export const ACTIVE_RUN_VERSION = 1 as const

/** active-run marker 的内容。 */
export interface ActiveRunMarker {
  readonly schemaVersion: 1
  readonly startedAt: string
  readonly appVersion: string
  readonly pid: number
}

/**
 * 序列化 active-run marker（稳定键序，结尾一个换行）。
 * @param facts - 启动事实。
 * @returns marker 文本。
 */
export function serializeActiveRunMarker(facts: { startedAt: string; appVersion: string; pid: number }): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    startedAt: facts.startedAt,
    appVersion: facts.appVersion,
    pid: facts.pid,
  }, null, 2)}\n`
}

/** 是否为普通对象（非 null、非数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 严格解析 active-run marker 文本。任何 JSON/schema 问题返回 null
 * （损坏的 marker 只是失去一条证据，绝不挡启动、绝不猜测）。
 * @param content - marker 文件文本。
 * @returns marker 或 null。
 */
export function parseActiveRunMarker(content: string): ActiveRunMarker | null {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  if (raw.schemaVersion !== ACTIVE_RUN_VERSION) return null
  if (typeof raw.startedAt !== 'string' || raw.startedAt.length === 0) return null
  if (typeof raw.appVersion !== 'string' || raw.appVersion.length === 0) return null
  if (typeof raw.pid !== 'number' || !Number.isFinite(raw.pid) || raw.pid < 0) return null
  return { schemaVersion: 1, startedAt: raw.startedAt, appVersion: raw.appVersion, pid: raw.pid }
}

/** crash dump 收集计划的一个事实条目。 */
export interface CrashDumpFact {
  /** 文件名（basename，仅用于清单展示）。 */
  name: string
  /** 完整路径（收集执行用）。 */
  path: string
  /** 字节大小。 */
  bytes: number
  /** 修改时间（epoch 毫秒；最近者优先保留）。 */
  mtime: number
}

/** crash dump 收集计划：保留清单 + 被跳过清单（如实记录，绝不伪造）。 */
export interface CrashDumpPlan {
  include: CrashDumpFact[]
  skipped: { name: string; reason: string }[]
}

/**
 * 规划 crash dump 收集：按修改时间新→旧排序，累计字节 ≤ budget；
 * 超出 budget 或单个文件超过剩余空间的条目如实记入 skipped（原因注明）。
 * 纯函数：只算计划，不读盘、不删除。
 * @param facts - 候选 dump 事实（无序）。
 * @param budgetBytes - 收集总量上限。
 * @returns 收集计划。
 */
export function planCrashDumpCollection(facts: readonly CrashDumpFact[], budgetBytes: number): CrashDumpPlan {
  const sorted = [...facts].sort((a, b) => b.mtime - a.mtime)
  const include: CrashDumpFact[] = []
  const skipped: { name: string; reason: string }[] = []
  let used = 0
  for (const fact of sorted) {
    if (fact.bytes < 0) {
      skipped.push({ name: fact.name, reason: 'size unavailable' })
      continue
    }
    if (used + fact.bytes > budgetBytes) {
      skipped.push({
        name: fact.name,
        reason: `budget exceeded (would reach ${String(used + fact.bytes)} of ${String(budgetBytes)} bytes)`,
      })
      continue
    }
    used += fact.bytes
    include.push(fact)
  }
  return { include, skipped }
}

/** crash evidence 总量上限（字节）：不因一个大 dump OOM/卡死。 */
export const CRASH_EVIDENCE_BUDGET_BYTES = 50 * 1024 * 1024
