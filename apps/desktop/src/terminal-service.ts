/**
 * DSH Terminal 服务纯函数：argv 级 Profile 默认、终端宿主选择（Windows
 * Terminal → PowerShell → cmd）、cwd 解析、welcome 组装与私有 shim 生成。
 * 全部纯函数（fs/env 探测经注入面传入），不依赖 Electron，便于单元测试。
 * shim 只转发到当前 exact executable，不下载 Runtime、不猜测系统安装；
 * 生成的 shim 目录只 prepend 给 DeepSeekGUI 新开的 terminal process，绝不
 * 污染父系统环境或任何永久环境变量。
 * @module @see-sol-lab/deepseekgui/terminal-service
 */

import type { DiscoveredProfile, ProfileDiscoveryV1 } from './profile-discovery.ts'

/** 终端宿主选择结果。 */
export interface TerminalShellChoice {
  /** external = 独立系统终端窗口（Windows Terminal）；embedded = ConPTY 内嵌。 */
  kind: 'external' | 'embedded'
  /** 诊断标签（welcome/错误消息用）。 */
  label: string
  /** 探测到的 exact executable。 */
  executable: string
  /** exact argv（绝不 shell string；cwd 由调用方以工作目录选项传入）。 */
  args: string[]
}

/** 文件存在性探测注入面（测试 mock absent）。 */
export interface ShellProbe {
  exists: (path: string) => boolean
}

/** 各终端宿主的 exact 路径（只认系统标准位置，不猜用户安装）。 */
const WINDOWS_TERMINAL_ALIAS = (localAppData: string | undefined): string =>
  `${localAppData ?? ''}\\Microsoft\\WindowsApps\\wt.exe`
/** PowerShell 7 的候选安装位置（标准目录 + Store 别名）。 */
function POWERSHELL7_CANDIDATES(localAppData: string | undefined): readonly string[] {
  return [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    ...localAppData === undefined ? [] : [`${localAppData}\\Microsoft\\WindowsApps\\pwsh.exe`],
  ]
}
const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CMD_EXE = 'C:\\Windows\\System32\\cmd.exe'

/** PowerShell 7 是否已安装（用户终端优先探测项；绝不影响 Agent sandbox）。 */
export function hasPowerShell7(probe: ShellProbe, localAppData: string | undefined): boolean {
  return POWERSHELL7_CANDIDATES(localAppData).some(path => probe.exists(path))
}

/** PowerShell 7 的第一个可用 exact 路径；未安装返回 null。 */
export function resolvePowerShell7Path(probe: ShellProbe, localAppData: string | undefined): string | null {
  return POWERSHELL7_CANDIDATES(localAppData).find(path => probe.exists(path)) ?? null
}

/**
 * 终端宿主选择：Windows Terminal（wt.exe，App Execution Alias）→
 * PowerShell 7（用户终端优先推荐，仅 UX）→ PowerShell（System32）→
 * cmd（System32）。每个候选用探测到的 exact executable + argv 直接
 * spawn；一个候选不存在才进入下一候选，启动后的真实失败由调用方明确
 * 报告，绝不做无限 fallback。
 * PowerShell 7 的探测只影响**用户打开的 DSH Terminal**——Agent 的
 * sandboxed PowerShell 走 Harness 的 tool/security 路径，绝不因发现
 * pwsh.exe 就绕过 sandbox。
 * @param probe - 存在性探测。
 * @param localAppData - LOCALAPPDATA（wt 别名目录）。
 * @returns 第一个存在的宿主。
 */
export function resolveTerminalShell(probe: ShellProbe, localAppData: string | undefined): TerminalShellChoice {
  const wt = WINDOWS_TERMINAL_ALIAS(localAppData)
  if (probe.exists(wt)) {
    return { kind: 'external', label: 'Windows Terminal', executable: wt, args: [] }
  }
  const pwsh7 = resolvePowerShell7Path(probe, localAppData)
  if (pwsh7 !== null) {
    return { kind: 'embedded', label: 'PowerShell 7', executable: pwsh7, args: ['-NoLogo'] }
  }
  if (probe.exists(POWERSHELL_EXE)) {
    return { kind: 'embedded', label: 'PowerShell', executable: POWERSHELL_EXE, args: ['-NoLogo'] }
  }
  return { kind: 'embedded', label: 'cmd', executable: CMD_EXE, args: ['/d'] }
}

/**
 * POSIX 终端宿主选择：$SHELL（用户自选 shell，存在才用）→ /bin/bash →
 * /bin/sh。全部内嵌 PTY——Linux 没有 Windows Terminal 那样可探测的标准
 * 外置终端（各发行版终端各异），不猜测。与 Windows 链同一契约：exact
 * executable + argv，一个候选不存在才进入下一候选，启动后的真实失败由
 * 调用方明确报告。
 * @param probe - 存在性探测。
 * @param shellEnv - `$SHELL`（用户登录 shell；可能未设置）。
 * @returns 第一个存在的宿主。
 */
export function resolvePosixTerminalShell(probe: ShellProbe, shellEnv: string | undefined): TerminalShellChoice {
  if (shellEnv !== undefined && shellEnv !== '' && probe.exists(shellEnv)) {
    const label = shellEnv.split('/').pop() ?? shellEnv
    return { kind: 'embedded', label, executable: shellEnv, args: [] }
  }
  if (probe.exists('/bin/bash')) {
    return { kind: 'embedded', label: 'bash', executable: '/bin/bash', args: [] }
  }
  return { kind: 'embedded', label: 'sh', executable: '/bin/sh', args: [] }
}

/** resolveTerminalCwd 的结果：cwd 与 welcome 里要说明的注记。 */
export interface TerminalCwdChoice {
  /** 终端工作目录（exact 绝对路径）。 */
  cwd: string
  /** 非空 = welcome 追加一行说明（如"未找到 Profile 目录，回退 Harness Home"）。 */
  note: string | null
}

/**
 * 终端 cwd：优先 active Profile 目录（discovery 的 dir 事实）；无法解析
 * 时使用 Harness Home 并在 welcome 说明。绝不静默锚到 Electron install
 * dir。说明文案按 locale 双语（D29）。
 * @param discovery - 最近一次只读 discovery（可能为 null）。
 * @param activeProfile - active Profile 名。
 * @param dshHome - launcher active Home 解析出的真实 DSH_HOME。
 * @param exists - 目录存在性探测。
 * @param locale - 界面语言（说明文案语言）。
 * @returns cwd 选择。
 */
export function resolveTerminalCwd(
  discovery: ProfileDiscoveryV1 | null,
  activeProfile: string,
  dshHome: string,
  exists: (path: string) => boolean,
  locale: 'zh' | 'en',
): TerminalCwdChoice {
  const zh = locale === 'zh'
  const profileDir = discovery?.profiles.find((profile: DiscoveredProfile) => profile.name === activeProfile)?.dir
  if (profileDir !== undefined && exists(profileDir)) {
    return { cwd: profileDir, note: null }
  }
  const note = profileDir === undefined
    ? (zh
      ? '未在 discovery 中找到当前 Profile 目录，已使用 Harness Home 作为工作目录。'
      : 'The active profile directory was not found in discovery; using the Harness Home as the working directory.')
    : (zh
      ? '当前 Profile 目录不可用，已使用 Harness Home 作为工作目录。'
      : 'The active profile directory is unavailable; using the Harness Home as the working directory.')
  return { cwd: dshHome, note }
}

/** buildTerminalWelcome 的输入事实（全部受控来源）。 */
export interface TerminalWelcomeFacts {
  appVersion: string
  dshVersion: string
  nodeVersion: string
  pnpmVersion: string | null
  activeProfile: string
  dshHome: string
  shellLabel: string
  cwd: string
  cwdNote: string | null
}

/**
 * Terminal welcome：DeepSeekGUI version、DSH version、Active Profile、
 * DSH_HOME、Node/pnpm/dsh 的私有 Runtime 来源，以及终端宿主与 cwd
 * （含 cwd 回退说明）。不显示任何凭据或环境变量。文案按 locale 双语
 * （D29：zh 保持原样，en 为母语级新写）。
 * @param facts - 受控事实。
 * @param locale - 界面语言。
 * @returns 多行 welcome 文本（host 以 echo 逐行写入 pty）。
 */
export function buildTerminalWelcome(facts: TerminalWelcomeFacts, locale: 'zh' | 'en'): string[] {
  const zh = locale === 'zh'
  const pnpm = facts.pnpmVersion ?? 'unknown'
  return [
    'DeepSeekGUI DSH Terminal',
    `DeepSeekGUI ${facts.appVersion} · DSH ${facts.dshVersion}`,
    `Active Profile: ${facts.activeProfile}`,
    `DSH_HOME: ${facts.dshHome}`,
    zh
      ? `Runtime: Node ${facts.nodeVersion} · pnpm ${pnpm} · dsh — 全部来自 DeepSeekGUI 私有 Runtime`
      : `Runtime: Node ${facts.nodeVersion} · pnpm ${pnpm} · dsh — all from the DeepSeekGUI private runtime`,
    `Terminal: ${facts.shellLabel} · cwd: ${facts.cwd}`,
    ...facts.cwdNote === null ? [] : [facts.cwdNote],
    // P8-D36：没有提示符语义的用户不知道黑窗在等输入——住户实测对着一个
    // 正常工作的终端说「没反应，光标都没有」。最后一行必须说人话。
    zh
      ? '这是已配好 DSH 环境的命令行，输入命令后按回车执行，例如：dsh --help'
      : 'This command line is pre-configured with the DSH environment. Type a command and press Enter, e.g. dsh --help',
  ]
}

/** 私有 shim 生成的运行时事实（全部 exact 值，由 main 从当前形态解析）。 */
export interface ShimRuntimeFacts {
  /** node 形态的可执行文件（dev = node exe；packaged = DeepSeekGUI.exe）。 */
  nodeExecutable: string
  /** node 形态的前缀 args（packaged = --expose-internals；dev = 空）。 */
  nodePrefixArgs: string[]
  /** dsh wrapper 脚本的绝对路径（静态 CJS，dev/packaged 同一文件）。 */
  dshWrapperPath: string
  /** dsh 入口（dev = apps/cli/src/bin.ts；packaged = runtime bin.js）。 */
  dshBin: string
  /** dsh 入口的前缀 args（dev = --import tsx/esm；packaged = --expose-internals）。 */
  dshNodeArgs: string[]
  /** pnpm 运行 args（packaged = --expose-internals + pnpm.cjs；dev = pnpm 模块路径）。 */
  pnpmArgs: string[]
  /** 当前 active Profile（注入 bare dsh 的默认）。 */
  activeProfile: string
}

/** 生成一个 .cmd shim 文件的文本（exact argv 转发，绝不 shell 解析）。 */
function shimCmd(
  executable: string,
  prefixArgs: readonly string[],
  envSets: readonly string[],
): string {
  const head = ['@echo off', ...envSets]
  if (prefixArgs.length === 0) {
    head.push(`"${executable}" %*`)
  } else {
    head.push(`"${executable}" ${prefixArgs.join(' ')} %*`)
  }
  return `${head.join('\r\n')}\r\n`
}

/**
 * dsh.cmd 专用模板：转发到 wrapper（wrapper 做 argv 级 Profile 默认并
 * spawn 真实 dsh），用户 argv 原样透传。
 * @param facts - 运行时事实。
 * @returns .cmd 文本。
 */
function dshShimCmd(facts: ShimRuntimeFacts): string {
  const prefix = facts.nodePrefixArgs.length === 0 ? '' : `${facts.nodePrefixArgs.join(' ')} `
  return [
    '@echo off',
    'set "ELECTRON_RUN_AS_NODE=1"',
    `set "DEEPSEEKGUI_WRAPPER_EXE=${facts.nodeExecutable}"`,
    `set "DEEPSEEKGUI_WRAPPER_DSH_BIN=${facts.dshBin}"`,
    `set "DEEPSEEKGUI_WRAPPER_NODE_ARGS=${JSON.stringify(facts.dshNodeArgs)}"`,
    `set "DEEPSEEKGUI_ACTIVE_PROFILE=${facts.activeProfile}"`,
    `"${facts.nodeExecutable}" ${prefix}"${facts.dshWrapperPath}" %*`,
    '',
  ].join('\r\n')
}

/**
 * 生成应用私有 shim 目录（app-owned/userData 位置）中的 node/dsh/pnpm
 * 三个 .cmd：只转发到当前 exact executable，不下载 Runtime、不猜测
 * 系统安装。返回各文件内容；调用方只把该目录 prepend 给新开的
 * terminal process，绝不写系统/用户 PATH、注册表或 shell 配置。
 * @param facts - 运行时事实。
 * @returns shim 文件名 → 文件文本。
 */
export function terminalShimContents(facts: ShimRuntimeFacts): Map<string, string> {
  const files = new Map<string, string>()
  files.set('node.cmd', shimCmd(facts.nodeExecutable, facts.nodePrefixArgs, ['set "ELECTRON_RUN_AS_NODE=1"']))
  files.set('dsh.cmd', dshShimCmd(facts))
  files.set('pnpm.cmd', shimCmd(facts.nodeExecutable, facts.pnpmArgs, ['set "ELECTRON_RUN_AS_NODE=1"']))
  return files
}

/** 生成一个 POSIX shim 文件的文本（exact argv 转发；`"$@"` 原样透传）。 */
function shimSh(
  executable: string,
  prefixArgs: readonly string[],
  envExports: readonly string[],
): string {
  const prefix = prefixArgs.length === 0 ? '' : `${prefixArgs.join(' ')} `
  return `${['#!/bin/sh', ...envExports, `exec "${executable}" ${prefix}"$@"`].join('\n')}\n`
}

/**
 * dsh 专用 POSIX 模板：与 dshShimCmd 同一转发协议（wrapper 做 argv 级
 * Profile 默认并 spawn 真实 dsh）。JSON 值走单引号，路径走双引号——
 * 与 .cmd 侧同一层级的字面量约定，不做通用转义。
 * @param facts - 运行时事实。
 * @returns POSIX shim 文本。
 */
function dshShimSh(facts: ShimRuntimeFacts): string {
  const prefix = facts.nodePrefixArgs.length === 0 ? '' : `${facts.nodePrefixArgs.join(' ')} `
  return [
    '#!/bin/sh',
    'export ELECTRON_RUN_AS_NODE=1',
    `export DEEPSEEKGUI_WRAPPER_EXE="${facts.nodeExecutable}"`,
    `export DEEPSEEKGUI_WRAPPER_DSH_BIN="${facts.dshBin}"`,
    `export DEEPSEEKGUI_WRAPPER_NODE_ARGS='${JSON.stringify(facts.dshNodeArgs)}'`,
    `export DEEPSEEKGUI_ACTIVE_PROFILE="${facts.activeProfile}"`,
    `exec "${facts.nodeExecutable}" ${prefix}"${facts.dshWrapperPath}" "$@"`,
    '',
  ].join('\n')
}

/**
 * terminalShimContents 的 POSIX 形态：同一转发协议，产出无扩展名的
 * node/dsh/pnpm 三个 shell 脚本（调用方负责 chmod +x）。
 * @param facts - 运行时事实。
 * @returns shim 文件名 → 文件文本。
 */
export function terminalShimContentsPosix(facts: ShimRuntimeFacts): Map<string, string> {
  const files = new Map<string, string>()
  files.set('node', shimSh(facts.nodeExecutable, facts.nodePrefixArgs, ['export ELECTRON_RUN_AS_NODE=1']))
  files.set('dsh', dshShimSh(facts))
  files.set('pnpm', shimSh(facts.nodeExecutable, facts.pnpmArgs, ['export ELECTRON_RUN_AS_NODE=1']))
  return files
}
