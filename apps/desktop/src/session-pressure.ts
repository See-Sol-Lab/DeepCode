/**
 * How many sessions a Home is carrying, and whether that is enough to be
 * worth telling the user about.
 *
 * The session projection cache keeps one row per session and never drops one:
 * a deleted conversation leaves its row behind, so the file only grows. At a
 * few kilobytes per row that is invisible for a long time and then is not —
 * upstream has a report of the cache growing until V8 ran out of memory on
 * every boot, which the reporter escaped by renaming the file.
 *
 * DeepCode does not clean up on the user's behalf. It counts, and when the
 * count crosses the threshold it says so where the user will see it. What to
 * do about it is theirs to decide — these are their conversations.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Session count past which DeepCode starts warning.
 *
 * Not a cliff — nothing breaks at 50,000. It is the order of magnitude where
 * the cache reaches the hundreds of megabytes that have actually broken
 * someone, chosen to leave room to act rather than to mark the failure point.
 */
export const SESSION_WARNING_THRESHOLD = 50_000

/** Sessions live under `<home>/sessions/<workspace>/<session-id>/`. */
const SESSIONS_DIRNAME = 'sessions'

/** How long a count stays good enough to reuse. */
const COUNT_CACHE_MS = 5 * 60 * 1000

/** The pressure reading DeepCode shows in the settings page. */
export interface SessionPressure {
  /** Sessions counted under this Home. */
  count: number
  /** The threshold that was crossed. */
  threshold: number
}

interface CachedCount {
  count: number
  at: number
}

const counts = new Map<string, CachedCount>()

/**
 * Count session directories under a Home.
 *
 * Counts directories rather than files: one session is one directory, and a
 * two-level readdir over workspaces beats walking every session log. A home
 * with no sessions directory yet counts zero rather than failing — a fresh
 * install is not an error state.
 * @param homePath - the Home to count under.
 * @returns the number of session directories, or 0 when the tree is absent or unreadable.
 */
export function countSessions(homePath: string): number {
  const root = join(homePath, SESSIONS_DIRNAME)
  if (!existsSync(root)) return 0
  let total = 0
  let workspaces: string[]
  try {
    workspaces = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return 0
  }
  for (const workspace of workspaces) {
    try {
      total += readdirSync(join(root, workspace), { withFileTypes: true })
        .filter(entry => entry.isDirectory()).length
    } catch {
      // One unreadable workspace does not invalidate the rest of the count.
      continue
    }
  }
  return total
}

/**
 * Read the session pressure for a Home, counting at most once per cache window.
 *
 * The control model refreshes on a timer, and a home holding tens of thousands
 * of sessions is exactly the one where re-counting on every refresh would be
 * felt. The number moves slowly by nature, so a stale reading costs nothing.
 * @param homePath - the Home to read.
 * @param now - clock, injectable for tests.
 * @param threshold - warning threshold; injectable so a test need not create 50,000 directories.
 * @returns the reading when the threshold is crossed, otherwise null.
 */
export function readSessionPressure(
  homePath: string,
  now: () => number = Date.now,
  threshold: number = SESSION_WARNING_THRESHOLD,
): SessionPressure | null {
  const at = now()
  const cached = counts.get(homePath)
  const count = cached !== undefined && at - cached.at < COUNT_CACHE_MS
    ? cached.count
    : countSessions(homePath)
  counts.set(homePath, { count, at })
  if (count < threshold) return null
  return { count, threshold }
}

/** Drop every cached count. Test seam; also correct after a Home switch. */
export function clearSessionPressureCache(): void {
  counts.clear()
}
