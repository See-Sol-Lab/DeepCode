/**
 * DeepSeekGUI 交付身份的四元组版本事实。
 * 四个事实各有唯一权威来源，绝不维护第二份手写常量：
 * - DeepSeekGUI app version：apps/desktop/package.json（打包态经 electron-builder
 *   写入 exe 元数据，运行时由 app.getVersion() 读回；开发态直接读 manifest）。
 * - embedded DSH version：实际打包 Runtime 的
 *   `resources/dsh/node_modules/@deepseek-ai/dsh/package.json`；开发态对应
 *   源码入口 apps/cli/package.json。任何读取失败都 fail loud——版本事实
 *   缺失是交付缺陷，不是可回退的展示细节。
 * - embedded DSH source/commit identifier：构建时由 build-desktop-dist 写入
 *   `resources/dsh/source-commit.txt`（git HEAD + dirty 标记）；打包态缺失
 *   fail loud，开发态实时 git rev-parse，无 git 环境回退 null。
 * - Electron version + platform/arch：运行时 process 事实。
 * 纯 Node 模块，不依赖 Electron，便于单元测试。
 * @module @see-sol-lab/deepseekgui/version-info
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/** 打包态 embedded DSH runtime 内 dsh 包 manifest 的相对路径（resourcesPath 下）。 */
export const EMBEDDED_DSH_MANIFEST = join('dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')

/** 打包态 source commit 标识文件的相对路径（resourcesPath 下）。 */
export const SOURCE_COMMIT_FILENAME = join('dsh', 'source-commit.txt')

/** 开发态 embedded DSH 对应的源码 manifest（apps/cli 即 @deepseek-ai/dsh）。 */
const DEV_DSH_MANIFEST = join('apps', 'cli', 'package.json')

/** 开发态 DeepSeekGUI app version 的 manifest。 */
const DEV_APP_MANIFEST = join('apps', 'desktop', 'package.json')

/** DeepSeekGUI 交付身份的四元组版本事实。 */
export interface DeepSeekGUIVersionInfo {
  /** DeepSeekGUI app version（唯一手写源头：apps/desktop/package.json）。 */
  appVersion: string
  /** embedded DSH version（从实际打包 Runtime / 源码 manifest 读取）。 */
  embeddedDshVersion: string
  /** embedded DSH source/commit 标识；开发态无 git 环境时为 null。 */
  sourceCommit: string | null
  /** Electron 运行时版本。 */
  electronVersion: string
  /** 运行平台（process.platform）。 */
  platform: string
  /** 运行架构（process.arch）。 */
  arch: string
}

/** 版本事实缺失或读取失败时的明确错误（绝不静默回退占位值）。 */
export class VersionInfoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VersionInfoError'
  }
}

/**
 * 读取 package.json 的 version 字段；缺失或非法时 fail loud。
 * @param path - manifest 的绝对路径。
 * @param what - 该 manifest 对应的事实名称（用于错误消息）。
 * @returns version 字符串。
 */
export function readManifestVersion(path: string, what: string, zh = true): string {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new VersionInfoError(zh
      ? `无法读取 ${what}（${path}）: ${String(error instanceof Error ? error.message : error)}`
      : `Could not read ${what} (${path}): ${String(error instanceof Error ? error.message : error)}`)
  }
  const version = (raw as Record<string, unknown>).version
  if (typeof version !== 'string' || version.length === 0) {
    throw new VersionInfoError(zh
      ? `${what}（${path}）缺少有效的 version 字段`
      : `${what} (${path}) does not contain a valid version field`)
  }
  return version
}

/**
 * 开发态 DeepSeekGUI app version：读 apps/desktop/package.json。
 * @param root - 仓库根目录。
 * @returns version 字符串。
 */
export function readDevAppVersion(root: string, zh = true): string {
  return readManifestVersion(join(root, DEV_APP_MANIFEST), 'DeepSeekGUI app manifest', zh)
}

/**
 * 打包态 embedded DSH version：读实际打包 Runtime 的 dsh manifest。
 * @param resourcesPath - process.resourcesPath。
 * @returns version 字符串。
 */
export function readEmbeddedDshVersion(resourcesPath: string, zh = true): string {
  return readManifestVersion(join(resourcesPath, EMBEDDED_DSH_MANIFEST), 'embedded DSH runtime manifest', zh)
}

/**
 * 开发态 embedded DSH version：读源码入口 apps/cli/package.json。
 * @param root - 仓库根目录。
 * @returns version 字符串。
 */
export function readDevDshVersion(root: string, zh = true): string {
  return readManifestVersion(join(root, DEV_DSH_MANIFEST), 'DSH CLI manifest', zh)
}

/**
 * 打包态 source/commit 标识：读构建时写入的 source-commit.txt；
 * 打包产物缺失该文件即版本事实缺失，fail loud。
 * @param resourcesPath - process.resourcesPath。
 * @returns commit 标识字符串。
 */
export function readSourceCommitFile(resourcesPath: string, zh = true): string {
  const path = join(resourcesPath, SOURCE_COMMIT_FILENAME)
  try {
    const content = readFileSync(path, 'utf8').trim()
    if (content.length === 0) throw new Error(zh ? '文件为空' : 'the file is empty')
    return content
  } catch (error) {
    throw new VersionInfoError(zh
      ? `无法读取 embedded DSH source/commit 标识（${path}）: ${String(error instanceof Error ? error.message : error)}`
      : `Could not read the embedded DSH source/commit identifier (${path}): ${String(error instanceof Error ? error.message : error)}`)
  }
}

/**
 * 开发态 source/commit 标识：实时 git rev-parse HEAD，工作树有未提交
 * 变更时追加 +dirty；git 不可用（非 git checkout 等）返回 null。
 * @param root - 仓库根目录。
 * @returns commit 标识，或 null。
 */
export function readDevSourceCommit(root: string): string | null {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  if (head.status !== 0 || head.stdout.trim().length === 0) return null
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
  const dirty = status.status === 0 && status.stdout.trim().length > 0 ? '+dirty' : ''
  return `${head.stdout.trim()}${dirty}`
}

/** buildVersionInfo 的输入事实。 */
export interface VersionInfoInput {
  /** 打包态（发行目录）还是开发态（源码仓库）。 */
  packaged: boolean
  /** DeepSeekGUI app version（打包态由 app.getVersion() 提供；开发态由 readDevAppVersion 提供）。 */
  appVersion: string
  /** 打包态 process.resourcesPath；开发态仓库根目录。 */
  root: string
  /** Electron 运行时版本（process.versions.electron）。 */
  electronVersion: string
  /** 运行平台（process.platform）。 */
  platform: string
  /** 运行架构（process.arch）。 */
  arch: string
  /** 是否使用中文错误文案。 */
  zh?: boolean
}

/**
 * 组装四元组版本事实：app version 由调用方注入（打包态 exe 元数据、
 * 开发态 manifest），其余三项从各自权威来源读取。任何读取失败都抛出
 * VersionInfoError，调用方决定失败语义（About 展示前必须拿到全部事实）。
 * @param input - 输入事实。
 * @returns 完整版本事实。
 */
export function buildVersionInfo(input: VersionInfoInput): DeepSeekGUIVersionInfo {
  const zh = input.zh ?? true
  return {
    appVersion: input.appVersion,
    embeddedDshVersion: input.packaged
      ? readEmbeddedDshVersion(input.root, zh)
      : readDevDshVersion(input.root, zh),
    sourceCommit: input.packaged
      ? readSourceCommitFile(input.root, zh)
      : readDevSourceCommit(input.root),
    electronVersion: input.electronVersion,
    platform: input.platform,
    arch: input.arch,
  }
}
