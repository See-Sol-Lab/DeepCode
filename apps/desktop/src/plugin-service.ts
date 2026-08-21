/**
 * Plugin Manager v1 的纯逻辑层：inventory 三分类事实、官方 CLI 写操作
 * 的 exact argv 构造、post-check 判定与 restart handoff 状态。
 *
 * 铁律（与施工单一致）：
 * - 不建立 plugin database；展示事实只来自 B1 discovery（`dsh profiles
 *   --json`）、profile manifest 的 `dependencies`（只读文档）与官方 CLI
 *   输出。
 * - 三分类绝不混写：Profile Bundles（discovery 的 bundles 层事实）、
 *   Installed Dependencies（manifest 的 dependencies）、Effective/Loader
 *   facts（discovery 的 staticStatus/evidence）。package.json 里存在
 *   dependency 不等于插件已成功加载。
 * - 写操作只走官方 `dsh plugin --profile <target> <pnpm args...>`；本模块
 *   绝不手改 package.json、绝不手改 dsh.profile.bundles、绝不复制
 *   node_modules、绝不自行调 pnpm 猜 Loader composition。
 * - 所有 spec 作为 argv 单项传入；相对路径 spec 由本模块锚定到用户明确
 *   选择的 invoking directory（绝不锚到 Electron install directory）。
 * 纯 Node 模块，不依赖 Electron，便于单元测试。
 * @module @see-sol-lab/deepcode/plugin-service
 */

import { isAbsolute, resolve } from 'node:path'
import type { DiscoveredProfile, DiscoveredStaticStatus, ProfileDiscoveryV1 } from './profile-discovery.ts'

/** v1 支持的插件操作动作（官方 CLI 转发 pnpm 的真实动作）。 */
export type PluginAction = 'add' | 'remove' | 'update' | 'install'

/** 是否为合法的 v1 操作动作。 */
export function isPluginAction(value: unknown): value is PluginAction {
  return value === 'add' || value === 'remove' || value === 'update' || value === 'install'
}

// ---- Inventory：三分类事实 ----

/** Profile Bundles 区的一个条目。 */
export interface PluginBundleEntry {
  /** 包名（discovery bundles 里的 layer 名）。 */
  name: string
  /** 是否由 dependency 派生（依赖安装的插件已进 loader）；false = 模板/预置 bundle。 */
  fromDependency: boolean
}

/** Installed Dependencies 区的一个条目。 */
export interface PluginDependencyEntry {
  /** 包名（manifest dependencies 的键）。 */
  name: string
  /** 版本/spec 字符串（manifest dependencies 的值，原样展示）。 */
  spec: string
  /** 是否已进入 bundles 层（声明 dsh.bundle 且被官方 reconcile 进列表）。 */
  inBundles: boolean
}

/** 一个 target profile 的插件 inventory（三分类绝不混写）。 */
export interface PluginInventory {
  bundles: PluginBundleEntry[]
  dependencies: PluginDependencyEntry[]
  /** Effective/Loader facts：官方分类器输出。 */
  staticStatus: DiscoveredStaticStatus
  evidence: string[]
  /** 读取 manifest 失败等展示错误（只影响 dependencies 区展示，不挡其余）。 */
  manifestError: string | null
}

/** manifest 读取的结果：dependencies 或明确错误（绝不部分采纳）。 */
export type ManifestDependenciesResult =
  | { ok: true; dependencies: Record<string, string> }
  | { ok: false; error: string }

/**
 * 严格读取 profile 目录 package.json 的 dependencies 字段（只读文档）。
 * 未知结构（非对象、dependencies 非字符串记录）一律明确报错，绝不猜测。
 * @param raw - package.json 的原始文本。
 * @param profileDir - profile 目录（诊断用）。
 * @returns dependencies 或明确错误。
 */
export function parseManifestDependencies(raw: string, profileDir: string): ManifestDependenciesResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, error: `profile manifest 不是有效 JSON: ${String(error instanceof Error ? error.message : error)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `profile manifest 必须是 JSON 对象（${profileDir}）` }
  }
  const record = parsed as Record<string, unknown>
  const rawDeps = record.dependencies
  if (rawDeps === undefined) return { ok: true, dependencies: {} }
  if (typeof rawDeps !== 'object' || rawDeps === null || Array.isArray(rawDeps)) {
    return { ok: false, error: 'profile manifest 的 dependencies 必须是对象' }
  }
  const dependencies: Record<string, string> = {}
  for (const [name, spec] of Object.entries(rawDeps)) {
    if (typeof spec !== 'string') {
      return { ok: false, error: `dependency ${JSON.stringify(name)} 的 spec 必须是字符串` }
    }
    dependencies[name] = spec
  }
  return { ok: true, dependencies }
}

/**
 * 组装一个 profile 的 inventory。bundles 区来自 discovery（官方解析成功
 * 的 layer 名），dependencies 区来自只读 manifest，effective 区来自官方
 * 分类。bundles ∩ dependencies = 依赖派生的插件（fromDependency=true）；
 * bundles ∖ dependencies = 模板/预置 bundle。
 * @param profile - discovery 条目（undefined = 未发现该 profile）。
 * @param manifestResult - manifest dependencies 的读取结果。
 * @returns inventory。
 */
export function buildPluginInventory(
  profile: DiscoveredProfile | undefined,
  manifestResult: ManifestDependenciesResult,
): PluginInventory {
  if (profile === undefined) {
    return { bundles: [], dependencies: [], staticStatus: 'malformed', evidence: [], manifestError: null }
  }
  const dependencies = manifestResult.ok ? manifestResult.dependencies : {}
  const dependencyNames = new Set(Object.keys(dependencies))
  return {
    bundles: profile.bundles.map(name => ({
      name,
      fromDependency: dependencyNames.has(name),
    })),
    dependencies: Object.entries(dependencies).map(([name, spec]) => ({
      name,
      spec,
      inBundles: profile.bundles.includes(name),
    })),
    staticStatus: profile.staticStatus,
    evidence: [...profile.evidence],
    manifestError: manifestResult.ok ? null : manifestResult.error,
  }
}

/**
 * 校验一个 target profile 是否可作为写操作目标。v1 只允许同一 DSH_HOME
 * 下已发现的、非 malformed 的 profile：不触发官方 auto-init、不在坏配置
 * 上叠加写操作。
 * @param profileName - target profile 名。
 * @param discovery - 当前 discovery（null = 尚未发现）。
 * @returns null = 合法；否则为用户可读的拒绝原因。
 */
export function validatePluginTarget(profileName: string, discovery: ProfileDiscoveryV1 | null): string | null {
  if (discovery === null) return '尚未发现任何 profile；请先刷新 Profiles'
  const profile = discovery.profiles.find(item => item.name === profileName)
  if (profile === undefined) {
    return `Profile ${JSON.stringify(profileName)} 不存在；v1 只操作已发现的 profile，不会自动创建`
  }
  if (profile.staticStatus === 'malformed') {
    return `Profile ${JSON.stringify(profileName)} 配置有问题，不能作为插件操作目标；请先修复配置`
  }
  return null
}

// ---- 写操作构造：exact argv，绝不 shell 拼接 ----

/** 一次插件写操作的输入。 */
export interface PluginOperationRequest {
  action: PluginAction
  /** target profile 名（同一 DSH_HOME 下）。 */
  profile: string
  /** add 的 package spec；remove/update 的包名；install 为 null。 */
  spec: string | null
  /**
   * 相对路径 spec 的锚定目录（用户明确选择的 invoking directory）。
   * 相对 spec 会被解析为绝对路径后入 argv；非相对 spec 原样透传。
   */
  anchorDir: string | null
}

/** 相对路径 spec 的锚定结果。 */
export interface AnchoredSpec {
  /** 入 argv 的最终 spec（相对路径已解析为绝对）。 */
  spec: string
  /** 是否发生了锚定（相对 → 绝对）。 */
  anchored: boolean
}

/**
 * 相对文件系统 spec 的锚定：与官方 plugin.ts 的 anchorPathSpec 同一语法
 * 面（`file:`/`link:` 前缀 + `./`/`../` 路径），但锚点是用户选择的
 * invoking directory。绝对路径、registry 名、git spec 等一律原样透传，
 * 绝不猜测或改写。
 * @param spec - 用户输入的 spec。
 * @param anchorDir - 用户明确选择的 invoking directory（绝对路径）。
 * @returns 锚定结果。
 */
export function anchorLocalSpec(spec: string, anchorDir: string): AnchoredSpec {
  const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(spec)
  if (match?.groups?.path === undefined) return { spec, anchored: false }
  if (!isAbsolute(anchorDir)) {
    throw new Error(`本地插件的锚定目录必须是绝对路径（得到 ${JSON.stringify(anchorDir)}）`)
  }
  const prefix = match.groups.prefix ?? ''
  return { spec: `${prefix}${resolve(anchorDir, match.groups.path)}`, anchored: true }
}

/** 是否为相对文件系统 spec 形态（file:/link: 前缀 + ./ 或 ../）。 */
export function isRelativeSpec(spec: string): boolean {
  return /^(?:(?:file|link):)?\.{1,2}(?:[/\\].*)?$/.test(spec)
}

/** 从本地 spec 形态提取纯路径（剥掉 file:/link: 前缀）；非本地形态返回 null。 */
export function localSpecPath(spec: string): string | null {
  const stripped = spec.replace(/^(?:file|link):/, '')
  if (isRelativeSpec(spec)) return stripped // 相对形态（锚定后由调用方再判）
  if (isAbsolute(stripped)) return stripped
  return null
}

/** 本地 spec 存在性探测注入面（main 用 fs；测试注入 fake）。 */
export interface LocalSpecProbe {
  exists: (path: string) => boolean
  isDirectory: (path: string) => boolean
}

/**
 * 本地路径 spec 的 pre-check：pnpm 对不存在的目录只 WARN 并写入 link:
 * 依赖（exit 0，实测证据），因此"目标目录真实存在且是目录"必须在操作
 * 前由 desktop 自己证明。registry 名 / git spec / 非路径形态一律跳过。
 * @param request - 已通过 {@link validatePluginRequest} 的请求。
 * @param probe - 存在性探测。
 * @returns null = 可继续；否则明确拒绝原因。
 */
export function validateLocalSpecTarget(
  request: PluginOperationRequest,
  probe: LocalSpecProbe,
): string | null {
  if (request.action !== 'add' || request.spec === null) return null
  const anchored = request.anchorDir === null
    ? { spec: request.spec }
    : anchorLocalSpec(request.spec, request.anchorDir)
  const path = localSpecPath(anchored.spec)
  if (path === null) return null
  if (isRelativeSpec(request.spec)) {
    // 相对形态已锚定为绝对；这里再防御一次锚定结果。
    if (!isAbsolute(path)) return `本地插件路径锚定失败：${JSON.stringify(path)}`
  }
  if (!probe.exists(path)) {
    return `本地插件目录不存在：${path}（官方 CLI 对不存在的目录会静默写入 link 依赖，desktop 在操作前明确拒绝）`
  }
  if (!probe.isDirectory(path)) {
    return `本地插件路径不是目录：${path}`
  }
  return null
}

/**
 * 一个即将进入 argv 的值是否含官方 CLI 的 Windows shell 转发无法安全
 * 携带的字符（空白 + cmd 元字符 + 控制字符）。用户输入与锚定结果都要过
 * 这一关——最终 argv 才是交给下游的东西。
 * @param value - 待检查的 argv 值。
 * @returns 含不安全字符时为 true。
 */
export function unsafeForWindowsShellForward(value: string): boolean {
  // 空白由 s 类覆盖（含制表/换行/回车与 Unicode 空白）；控制字符范围
  // 特意跳过 0009-000d 段，避免与空白类重复（lint: duplicates-in-character-class）。
  return /[\s&|<>^%!"'`();,\u0000-\u0008\u000e-\u001f]/.test(value)
}

/**
 * 校验一条插件操作请求：动作/包名/spec 形态齐全、spec 不含空串、
 * 本地相对路径有锚定目录、remove/update 的目标是包名形态。
 * @param request - 待校验请求。
 * @returns null = 合法；否则拒绝原因。
 */
export function validatePluginRequest(request: PluginOperationRequest): string | null {
  if (request.profile === '' || request.profile.includes('/') || request.profile.includes('\\')
    || request.profile === '.' || request.profile === '..' || request.profile === 'node_modules') {
    return `非法的 Profile 名 ${JSON.stringify(request.profile)}`
  }
  if (request.action === 'install') {
    if (request.spec !== null) return 'install 不接受 package spec'
    return null
  }
  if (request.spec === null || request.spec.trim() === '') {
    return `${request.action} 需要一个包名或 spec`
  }
  // 空白字符一律拒绝：pnpm 的合法 spec（包名/URL）本就不含空白，而官方
  // CLI 在 Windows 上以 shell:true 转发 pnpm，含空格的本地路径会被 cmd
  // 拆词（实测会把路径各段当作独立包名）。desktop 不绕开官方 CLI，只
  // 在边界处明确拒绝并说明原因。
  if (/\s/.test(request.spec)) {
    return 'spec 不能包含空白字符；本地目录含空格时请先移动到无空格路径（官方 CLI 在 Windows 上无法转发含空格的路径参数）'
  }
  // cmd 元字符与控制字符一律拒绝：与空白拆词是同一个上游洞的另一半。
  // 上游 apps/cli/src/plugin.ts 为解析 pnpm 的 .cmd shim 使用
  // `shell: process.platform === 'win32'`，Node 在该模式下不转义 cmd
  // 元字符，spec 里的 & | < > ^ % ! ( ) ; , 与引号/反引号会被 cmd 解释
  // （验收方探针实证：`bogus-pkg-xyz&echo.>INJECTED.txt` 经官方 CLI 在
  // 目标 profile 目录写出 INJECTED.txt，退出码 0）。desktop 绝不绕开
  // 官方 CLI，只在边界拒绝一切无法安全携带的字符。
  //
  // 取舍（上游转发限制，非 DeepCode 产品选择）：含 | 或 > 或空格的
  // semver 复合范围（如 "1.x||2.x"、">=1 <2"）因此不被支持；插入符
  // 范围（^1.0.0）同样被拒——实证 `cmd /c echo pkg@^1.0.0` 输出
  // `pkg@1.0.0`，^ 被 cmd 当作转义符吞掉，范围语义被悄悄篡改成精确
  // 版本（这是注入面的另一形态）。波浪号与精确版本不受影响。持久修法
  // 属于上游（解析出 pnpm 的 .cmd 路径后 shell:false 直 spawn，或
  // execFile + 显式转义），出口按 B1 已定的两条路（上游 PR 或 DeepCode
  // Core adapter）；B2 不改上游。
  if (/[&|<>^%!"'`();,\u0000-\u001f]/.test(request.spec)) {
    return 'spec 包含官方 CLI 在 Windows shell 转发下无法安全携带的字符（& | < > ^ % ! " \' ` ( ) ; , 或控制字符）；含 | 或 > 或空格的 semver 复合范围（如 "1.x||2.x"、">=1 <2"）因此不支持'
  }
  // 锚定后的最终 argv 才是真正交给官方 CLI 的值：用户输入 `./local`
  // 干净，但锚定目录名本身可能含空格或 cmd 元字符（Windows 允许目录名
  // 含 & 空格 % ! ( ) 等）。验收方探针实证：锚定目录名
  // `p&copy nul INJECTED2.txt&rem` 配 spec `./local` 通过上面全部校验，
  // 经官方 CLI 在目标 profile 目录写出 INJECTED2.txt 且退出码 0——
  // 任意命令执行。字符校验必须作用于锚定结果，不能只看用户输入。
  if (isRelativeSpec(request.spec) && request.anchorDir !== null && isAbsolute(request.anchorDir)) {
    const anchored = anchorLocalSpec(request.spec, request.anchorDir).spec
    if (unsafeForWindowsShellForward(anchored)) {
      return `锚定目录的完整路径含官方 CLI 在 Windows shell 转发下无法安全携带的字符（空白或 & | < > ^ % ! " ' \` ( ) ; ,）：${request.anchorDir}；请把本地插件放到不含这些字符的路径下`
    }
  }
  if (request.action === 'remove') {
    // remove 只接受最严格的裸包名：带版本、路径或 git spec 都会被 pnpm 拒绝。
    if (!isStrictPackageName(request.spec)) {
      return 'remove 需要一个裸包名（不带版本；不支持路径或 git spec）'
    }
    return null
  }
  if (request.action === 'update') {
    // update 接受裸包名或 name@version；路径/git 形态拒绝。
    const name = expectedPackageName(request.spec)
    if (name === null || !isStrictPackageName(name)) {
      return 'update 需要一个包名（可选 @version；不支持路径或 git spec）'
    }
    return null
  }
  // add：相对路径 spec 必须提供用户选择的锚定目录。
  if (isRelativeSpec(request.spec) && (request.anchorDir === null || !isAbsolute(request.anchorDir))) {
    return '本地路径 spec 需要先选择锚定目录'
  }
  return null
}

/** npm 包名的最严格形态（小写、可含 -_.、@scope/name）。 */
export function isStrictPackageName(spec: string): boolean {
  return /^@[a-z0-9][a-z0-9-_.]*\/[a-z0-9][a-z0-9-_.]*$|^[a-z0-9][a-z0-9-_.]*$/.test(spec)
}

/**
 * 构造官方 CLI 的 exact argv：`plugin --profile <target> <action> [spec]`。
 * 每个 spec 都是单个 argv 元素（broker 的 shell:false 保证无注入面）；
 * 相对路径 spec 先经 {@link anchorLocalSpec} 锚定。
 * @param request - 操作请求（含 anchorDir）。
 * @returns 追加在 DSH 入口之后的 argv 数组。
 */
export function buildPluginOperationArgs(request: PluginOperationRequest): string[] {
  const args = ['plugin', '--profile', request.profile, request.action]
  if (request.spec !== null) {
    const { spec } = request.anchorDir === null
      ? { spec: request.spec }
      : anchorLocalSpec(request.spec, request.anchorDir)
    args.push(spec)
  }
  return args
}

// ---- post-check：exit 0 之后的结果证明 ----

/** 操作前/后的 target 快照（全部来自官方/只读事实）。 */
export interface PluginSnapshot {
  /** manifest dependencies：name → spec。 */
  dependencies: Record<string, string>
  /** discovery 的 bundles 层名。 */
  bundles: string[]
  /** discovery 的分类（install 用：坏配置上 install 不算通过）。 */
  staticStatus: DiscoveredStaticStatus
}

/** 一次 post-check 的判定结果。 */
export type PluginPostCheck =
  | { ok: true; evidence: string }
  | { ok: false; evidence: string }

/**
 * 从裸包名 spec（`name`、`@scope/name`、`name@ver`）提取包名；无法可靠
 * 提取（git/file/path/alias 等形态）返回 null——此时 add 的证明降级为
 * "出现了新的 dependency"。
 * @param spec - add 时的 spec。
 * @returns 包名或 null。
 */
export function expectedPackageName(spec: string): string | null {
  const trimmed = spec.trim()
  // 路径形态（相对、绝对、file:/link: 前缀）的真实包名只有 manifest 知道：
  // 必须显式返回 null，让调用方退回"出现了新 dependency"的证明路径。
  // Windows 绝对路径里既无 `/` 也无 `@`，会被下面的裸名分支整条吞成
  // "包名"，post-check 于是拿路径当 manifest 键去查，必然查不到——本地
  // 路径装插件因此总被判失败（打包验收实测：pnpm 明确输出
  // `+ deepcode-packaged-bundle-fixture <- ..\bundle-fixture` 且退出 0，
  // UI 仍报"退出 0 但验证与磁盘事实不符"并扣下 restart handoff）。
  if (localSpecPath(trimmed) !== null) return null
  const match = /^(?<name>@[^/@\s]+\/[^/@\s]+|[^/@\s]+)(?:@.*)?$/.exec(trimmed)
  return match?.groups?.name ?? null
}

/**
 * 对比操作前后快照，证明操作结果。所有判定只引用官方/只读事实：
 * - add：目标包名（可提取时）或"任一新 dependency"出现；
 * - remove：目标包名不再出现；
 * - update：目标包名仍在，spec 变化与否如实报告（不变 = 已是最新）；
 * - install：exit 0 的前提已由调用方保证，这里证明 discovery 仍可解析
 *   （bundles 完整、非 malformed）。
 * @param before - 操作前快照。
 * @param after - 操作后快照。
 * @param request - 原操作请求。
 * @returns 判定与证据文案。
 */
export function verifyPluginPostCheck(before: PluginSnapshot, after: PluginSnapshot, request: PluginOperationRequest): PluginPostCheck {
  switch (request.action) {
    case 'add': {
      const expected = request.spec === null ? null : expectedPackageName(request.spec)
      if (expected !== null) {
        if (after.dependencies[expected] === undefined) {
          return { ok: false, evidence: `add 后 dependency ${JSON.stringify(expected)} 未出现在 manifest 中` }
        }
        return { ok: true, evidence: `add 已验证：dependency ${expected}@${after.dependencies[expected]} 已安装` }
      }
      const added = Object.keys(after.dependencies).filter(name => before.dependencies[name] === undefined)
      if (added.length === 0) {
        return { ok: false, evidence: 'add 后 manifest 中没有出现任何新 dependency（spec 无法映射到包名，请核对安装输出）' }
      }
      return { ok: true, evidence: `add 已验证：新增 dependency ${added.map(name => JSON.stringify(name)).join(', ')}` }
    }
    case 'remove': {
      // 与 update 同源：一律经 expectedPackageName 取包名，两处对 spec 的
      // 理解绝不漂移（即使 validatePluginRequest 已强制 remove 裸包名）。
      const name = request.spec === null ? null : expectedPackageName(request.spec)
      if (name === null) {
        return { ok: false, evidence: `remove 的 spec ${JSON.stringify(request.spec)} 无法提取包名，无法验证` }
      }
      if (after.dependencies[name] !== undefined) {
        return { ok: false, evidence: `remove 后 dependency ${JSON.stringify(name)} 仍存在于 manifest 中` }
      }
      return { ok: true, evidence: `remove 已验证：dependency ${JSON.stringify(name)} 已移除` }
    }
    case 'update': {
      // name@version 形态：manifest 的键是裸包名，必须提取后再查。
      const name = request.spec === null ? null : expectedPackageName(request.spec)
      if (name === null) {
        return { ok: false, evidence: `update 的 spec ${JSON.stringify(request.spec)} 无法提取包名，无法验证` }
      }
      if (after.dependencies[name] === undefined) {
        return { ok: false, evidence: `update 后 dependency ${JSON.stringify(name)} 不在 manifest 中` }
      }
      const beforeSpec = before.dependencies[name]
      const afterSpec = after.dependencies[name] ?? ''
      if (beforeSpec === afterSpec) {
        return { ok: true, evidence: `update 已验证：dependency ${JSON.stringify(name)} 已是 ${afterSpec}（版本未变化）` }
      }
      return { ok: true, evidence: `update 已验证：${JSON.stringify(name)} 从 ${beforeSpec} 变为 ${afterSpec}` }
    }
    case 'install': {
      if (after.staticStatus === 'malformed') {
        return { ok: false, evidence: 'install 后 discovery 仍无法解析该 profile（malformed）' }
      }
      if (after.bundles.length === 0 && before.bundles.length > 0) {
        return { ok: false, evidence: 'install 后 bundles 层为空（操作前非空），可能损坏了依赖' }
      }
      return { ok: true, evidence: `install 已验证：discovery 可解析（bundles: ${after.bundles.length} 层）` }
    }
  }
}

// ---- 目标透明度确认（写操作前的对话框文案，纯函数可测） ----

/** 确认对话框的输入事实（全部受控来源，不含凭据）。 */
export interface PluginConfirmInput {
  homeKind: 'managed' | 'existing'
  /** 完整目标路径（解析后的 DSH_HOME；Existing 时就是用户选择的目录）。 */
  dshHome: string
  profile: string
  action: PluginAction
  spec: string | null
  locale: 'zh' | 'en'
}

/** 确认对话框的 message/detail 文案（detail 逐行列出 Home/路径/Profile/操作/spec）。 */
export interface PluginConfirmText {
  message: string
  detail: string
}

/** 操作动作的本地化标签。 */
export function pluginActionLabel(action: PluginAction, zh: boolean): string {
  if (zh) {
    return { add: '安装', remove: '移除', update: '更新', install: '安装 / 修复依赖' }[action]
  }
  return { add: 'Add', remove: 'Remove', update: 'Update', install: 'Install / repair dependencies' }[action]
}

/**
 * 组装写操作前的目标透明度确认文案。Existing Home 必须明确出现
 * 施工单要求的句子："这次操作会修改你选择的现有 Harness Profile。"
 * @param input - 确认输入事实。
 * @returns message + detail。
 */
export function pluginConfirmText(input: PluginConfirmInput): PluginConfirmText {
  const zh = input.locale === 'zh'
  const homeLabel = input.homeKind === 'managed' ? (zh ? '托管模式' : 'Managed') : (zh ? '已有目录' : 'Existing')
  const lines = [
    `Home：${homeLabel}`,
    `${zh ? '目标路径' : 'Target path'}：${input.dshHome}`,
    `Profile：${input.profile}`,
    `${zh ? '操作' : 'Operation'}：${pluginActionLabel(input.action, zh)}`,
    ...input.spec === null ? [] : [`Package：${input.spec}`],
  ]
  if (input.homeKind === 'existing') {
    lines.push('', '这次操作会修改你选择的现有 Harness Profile。')
  }
  return {
    message: zh ? '确认插件操作' : 'Confirm plugin operation',
    detail: lines.join('\n'),
  }
}

// ---- restart handoff：只提示，绝不自动重启 ----

/** 从退出码与 post-check 判定是否显示 restart handoff：成功且验证通过才提示。 */
export function shouldShowHandoff(
  exitCode: number | null,
  postCheck: PluginPostCheck | null,
): boolean {
  return exitCode === 0 && postCheck !== null && postCheck.ok
}
