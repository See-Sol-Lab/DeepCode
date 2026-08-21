/**
 * 官方 settings RPC 的纯类型面：与 {@link harness-api.ts} 分离，供
 * 需要 settings 视图类型的模块（如 permission-view）在不引入任何
 * node 值依赖（node:crypto）的前提下 import type。
 * 只含类型，不含任何运行时代码。
 * @module @see-sol-lab/deepcode/harness-api-types
 */

/** settings.mutate 的单个路径编辑操作。 */
export type SettingsPathOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/** settings.describe 返回的一个 namespace 视图（严格子集，其余字段不读）。 */
export interface SettingsNamespaceView {
  ns: string
  value: unknown
  applies: 'live' | 'restart'
  revision: number
}

/** settings.describe 的返回值（严格子集）。 */
export interface SettingsDescribeValue {
  writable: boolean
  hasDocument: boolean
  namespaces: SettingsNamespaceView[]
}
