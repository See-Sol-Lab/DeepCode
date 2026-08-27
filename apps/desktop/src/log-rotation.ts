/**
 * 诊断日志保留策略的纯逻辑层：把 current + .old 的两份轮转升级为
 * 有限份数 + 总大小 budget。最老先删、绝不无限增长；crash 证据在
 * 下一次普通启动时先 shift 进历史而不是被顶掉。
 *
 * 纯函数：只计算 rename/delete 计划，不执行任何文件操作——main 持
 * 行执行并处理失败；不建日志数据库、不建后台清理服务。
 * @module @see-sol-lab/deepseekgui/log-rotation
 */

/** 保留份数上限（current + 历史）。 */
export const LOG_MAX_FILES = 5

/** 全部日志的总大小 budget（超出则最老先删）。 */
export const LOG_TOTAL_BUDGET = 15 * 1024 * 1024

/** 日志目录里的一个候选文件事实（只读探测结果）。 */
export interface LogFileFact {
  /** 文件名（如 dsh-service.log / dsh-service.log.1）。 */
  name: string
  /** 字节数；读取失败为 null（保留，不因 stat 失败误删证据）。 */
  bytes: number | null
}

/** 轮转计划的文件操作。 */
export interface LogRotationPlan {
  /** 把 current 重命名为历史名（.1 → .2 → … 链由历史重命名承接）。 */
  renames: { from: string; to: string }[]
  /** 删除的历史文件（最老先删 / 超出 budget）。 */
  deletes: string[]
}

/** 历史文件的序号（dsh-service.log.3 → 3；非本日志族返回 null）。 */
function historyIndex(name: string): number | null {
  const match = /^dsh-service\.log\.(\d+)$/.exec(name)
  if (match === null) return null
  const index = Number(match[1])
  return Number.isInteger(index) && index >= 1 ? index : null
}

/**
 * 计算一次启动时的日志轮转计划：
 * 1) 全部历史序号 +1（.4 若已存在将先被删除——最老先删）；
 * 2) 把 current（若非空）重命名为 .1；
 * 3) 超出总大小 budget 的最老文件删除（从最大序号往下删）。
 * **renames 按目标序号降序输出**：执行方按数组顺序逐个执行即安全——
 * 最老的文件先搬到空位，绝不覆盖尚未搬走的文件（升序执行会把
 * `.1→.2` 先压掉原 `.2`，后面的 `.2→.3` 搬的是刚被覆盖的文件，形成
 * 序号空洞并丢失历史证据）。`deletes` 只包含"轮转前就存在、轮转后
 * 不保留"的旧文件名与"轮转后超出 budget"的目标名，两者都在 renames
 * 执行完毕后删除才安全。
 * stat 失败（bytes=null）的文件只参与份数轮转、不参与 budget 计算，
 * 绝不因探测失败误删证据。
 * @param facts - 目录内与当前日志同族的文件事实。
 * @param currentName - current 日志文件名。
 * @param opts - 份数/大小上限（测试注入）。
 * @returns 计划（可顺序执行的 rename 链 + 删除清单）。
 */
export function planLogRotation(
  facts: LogFileFact[],
  currentName: string,
  opts: { maxFiles?: number; totalBudget?: number } = {},
): LogRotationPlan {
  const maxFiles = opts.maxFiles ?? LOG_MAX_FILES
  const totalBudget = opts.totalBudget ?? LOG_TOTAL_BUDGET
  const renames: { from: string; to: string }[] = []
  const deletes: string[] = []
  const histories = facts
    .filter(fact => historyIndex(fact.name) !== null)
    .sort((a, b) => (historyIndex(a.name) ?? 0) - (historyIndex(b.name) ?? 0))
  // 最老先删：序号 >= maxFiles-1 的历史直接删除（给 +1 后的新链腾位置）。
  const maxKeptIndex = maxFiles - 2 // current → .1 之后的历史最高保留序号
  for (const fact of histories) {
    const index = historyIndex(fact.name) ?? 0
    if (index > maxKeptIndex) {
      deletes.push(fact.name)
    } else {
      renames.push({ from: fact.name, to: `${currentName}.${index + 1}` })
    }
  }
  const current = facts.find(fact => fact.name === currentName)
  if (current !== undefined && current.bytes !== null && current.bytes > 0) {
    renames.push({ from: currentName, to: `${currentName}.1` })
  }
  // 执行安全：目标序号降序（.N → .N+1 先于 .N-1 → .N），旧文件名先于
  // current（current 的 .1 目标最"新"，最后搬）。
  renames.sort((a, b) => {
    const aIndex = historyIndex(a.from) ?? 0
    const bIndex = historyIndex(b.from) ?? 0
    return bIndex - aIndex
  })
  // budget：轮转后的文件集合（current 已移入历史；新 current 由调用方新建）。
  const surviving = new Map<string, number>()
  for (const rename of renames) {
    const source = facts.find(fact => fact.name === rename.from)
    if (source !== undefined && source.bytes !== null) {
      surviving.set(rename.to, source.bytes)
    }
  }
  let total = 0
  for (const bytes of surviving.values()) total += bytes
  // 从最老的开始删（序号大 = 老），直到回到 budget 内。budget 删除是
  // 对"轮转后目标"的删除，与份数阶段的"旧文件"删除分开记账——两者
  // 名字可能相同（旧 .4 删除腾出的 .4 正是 .3 shift 的目标）。
  const budgetDeletes: string[] = []
  const byIndexDesc = [...surviving.keys()].sort((a, b) => (historyIndex(b) ?? 0) - (historyIndex(a) ?? 0))
  for (const name of byIndexDesc) {
    if (total <= totalBudget) break
    const bytes = surviving.get(name) ?? 0
    budgetDeletes.push(name)
    surviving.delete(name)
    total -= bytes
  }
  return {
    renames: renames.filter(rename => !budgetDeletes.includes(rename.to)),
    deletes: [...new Set([...deletes, ...budgetDeletes])],
  }
}
