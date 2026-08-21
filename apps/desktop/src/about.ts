/**
 * About 内容的组装：只从受控事实拼文本——DeepCode app version、embedded
 * DSH version/source、Electron、platform/arch、Active Home kind、Active
 * Profile、license summary 与 project repository。函数签名不接触任何
 * 环境变量、凭据或会话内容，因此 API key、credential、session 正文与
 * 完整环境变量在结构上不可能进入 About。
 * 纯 Node 模块，不依赖 Electron，便于单元测试。
 * @module @see-sol-lab/deepcode/about
 */

import type { DeepCodeVersionInfo } from './version-info.ts'

/** license summary 与项目仓库（交付身份常量，与 DEEPCODE_VERSIONING.md 同源）。 */
export const ABOUT_LICENSE_SUMMARY = 'DeepCode product layer: PolyForm Perimeter 1.0.1 · DeepSeek Harness runtime: MIT'
export const ABOUT_REPOSITORY = 'https://github.com/See-Sol-Lab/DeepCode'

/** About 详情的输入事实（全部受控来源）。 */
export interface AboutDetailInput {
  /** 版本四元组（app/DSH/source/Electron/arch）。 */
  version: DeepCodeVersionInfo
  /** Active Home kind（managed/existing），绝不含路径。 */
  homeKind: 'managed' | 'existing'
  /** Active Profile 名。 */
  profile: string
  /** 界面语言。 */
  locale: 'zh' | 'en'
}

/**
 * 从 pnpm 模块路径（npm_execpath）提取其包版本：corepack 缓存的
 * `…/pnpm/<version>/…` 或 pnpm store 的 `…/pnpm@<version>/…` 布局。
 * 解析失败返回 null（调用方显示 unknown），绝不猜测。
 * @param execpath - npm_execpath 值。
 * @returns 版本字符串或 null。
 */
export function pnpmVersionFromExecpath(execpath: string | undefined): string | null {
  if (execpath === undefined) return null
  const match = /pnpm[@\\/](?:v\d+[\\/])?(\d+\.\d+\.\d+)/.exec(execpath)
  if (match === null) return null
  return match[1] ?? null
}

/**
 * 组装 About 详情多行文本。只包含声明的受控事实；任何凭据形态字符串
 * （API key、token 等）都不在输入面内，调用方也无法传入。
 * @param input - 受控事实。
 * @returns 多行文本（\n 分隔）。
 */
export function aboutDetailText(input: AboutDetailInput): string {
  const { version } = input
  const commit = version.sourceCommit ?? 'unknown'
  const zh = input.locale === 'zh'
  const homeLabel = input.homeKind === 'managed'
    ? (zh ? '托管模式' : 'Managed')
    : (zh ? '已有目录' : 'Existing')
  const lines = zh
    ? [
      `DeepCode 版本：${version.appVersion}`,
      `内嵌 DSH 版本：${version.embeddedDshVersion}（source ${commit}）`,
      `Electron：${version.electronVersion} · ${version.platform}-${version.arch}`,
      `Harness Home：${homeLabel}`,
      `当前 Profile：${input.profile}`,
      `许可证：${ABOUT_LICENSE_SUMMARY}`,
      `项目仓库：${ABOUT_REPOSITORY}`,
    ]
    : [
      `DeepCode version: ${version.appVersion}`,
      `Embedded DSH version: ${version.embeddedDshVersion} (source ${commit})`,
      `Electron: ${version.electronVersion} · ${version.platform}-${version.arch}`,
      `Harness Home: ${homeLabel}`,
      `Active Profile: ${input.profile}`,
      `License: ${ABOUT_LICENSE_SUMMARY}`,
      `Repository: ${ABOUT_REPOSITORY}`,
    ]
  return lines.join('\n')
}
