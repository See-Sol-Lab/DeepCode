/**
 * S2 / S3 / S6 / S13 — 权限执行打包验收（打包态）：真实 agent 经官方
 * HTTP RPC（session.create / session.prompt，非 DeepCode 私有 API）在
 * packaged Harness 里执行 sandboxed PowerShell 工具：
 * - S2：workspace-write 的越界写被 **ACL confinement 硬拒绝**（受限进程
 *   不持有目标权限，OS 直接拒绝）——sentinel byte-identical、无兄弟文件、
 *   preset 不变、不 fallback Full Access；这条路径不经过 approval；
 * - S3：工作区内写经允许路径成功（不是"为安全把工具全禁了"）；
 * - S6a/S6b：**工具请求提权**（sandbox_permissions + justification）才是
 *   抵达 approval policy 的那条路——UI 真实可见、未答前不执行、Deny 后
 *   动作不发生、Approve once 后才执行，且 DeepCode 不存第二份信任状态；
 * - S13：无害 sandboxed PowerShell 动作执行成功，执行期间不出现可见
 *   pwsh 控制台窗口（黑框检测：按创建时间 + MainWindowHandle 采样）。
 * LLM 用 repo 内 mock server（每测试独立实例，tool_call_success →
 * pwsh 工具），零网络、零真实凭据；全部 destructive 断言落在隔离临时根。
 * @module @see-sol-lab/deepcode/tests-e2e/permission-execution
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ElectronApplication } from 'playwright-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import {
  isolationRoot as sharedIsolationRoot,
  packagedExists,
  stubDialogs,
  userDataDir,
} from './fixtures.ts'
import {
  COMP_URL_PREFIX,
  ensureCleanStage,
  evalInView,
  shutdownApp,
  waitForCompMount,
} from './chrome-driver.ts'
import { launchPackaged } from './fixtures.ts'

/** 本套件的隔离根：Unicode、无空格（argv 路径必须无空格）。 */
const isolationRoot = (suffix: string): string => sharedIsolationRoot(`dsh-exec-${suffix}-`, '执行s')

/** 官方 RPC 信封调用（测试侧驱动官方 API，不经 DeepCode 私有面）。 */
async function rpc(method: string, payload: unknown): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }> {
  const rpcId = Math.random().toString(36).slice(2)
  const response = await fetch(`http://127.0.0.1:3080/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  const body = await response.json() as { result?: { ok: boolean; value?: unknown; error?: { code: string; message: string } } }
  const result = body.result
  if (result === undefined) throw new Error(`RPC ${method}: 响应信封不符`)
  return result as { ok: boolean; value?: unknown; error?: { code: string; message: string } }
}

/** 官方 UI 里 approval 面板是否可见（等待审批 strip 或拒绝按钮）。 */
async function approvalVisible(app: ElectronApplication): Promise<boolean> {
  return evalInView<boolean>(
    app,
    COMP_URL_PREFIX,
    `Array.from(document.querySelectorAll('button')).some(b =>
      b.textContent?.includes('拒绝') || b.textContent?.includes('允许一次'))`,
  )
}

/** 官方 UI 里点击 approval 按钮（拒绝 / 允许一次）。 */
async function clickApproval(app: ElectronApplication, label: string): Promise<void> {
  const clicked = await evalInView<boolean>(
    app,
    COMP_URL_PREFIX,
    `(() => {
      const button = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes(${JSON.stringify(label)}))
      if (button === undefined || button.disabled) return false
      button.click()
      return true
    })()`,
  )
  expect(clicked, `approval 按钮 ${label} 不可点`).toBe(true)
}

/** 采样当前可见的 pwsh/powershell 控制台窗口（进程名 + 创建时间）。 */
function sampleVisiblePwshWindows(): string[] {
  const run = spawnSync('powershell', [
    '-NoProfile', '-Command',
    "Get-Process -Name pwsh,powershell -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.Name + '|' + $_.StartTime.ToUniversalTime().ToString('o') }",
  ], { encoding: 'utf8', timeout: 15_000 })
  if (run.status !== 0) return []
  return run.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
}

/** 起 mock LLM：第一轮返回 pwsh 工具调用，之后 repeat success。 */
async function startToolMock(toolArguments: Record<string, unknown>): Promise<MockLlmServer> {
  return startMockLlmServer({
    port: 0,
    apiKey: 'mock-key',
    sequence: ['tool_call_success', 'success'],
    repeatLast: true,
    toolName: 'pwsh',
    toolArguments: JSON.stringify(toolArguments),
  })
}

/**
 * 当前 permission preset —— 从官方 settings service 现读。
 *
 * 绝不改读 settings.yaml：Managed Home 的那份文档只在**确实需要写入**时
 * 才被创建，官方 permission service 自己推断出的默认值根本不落盘。断言
 * 文件内容会把"没写过盘"误判成"preset 不对"（实测踩过）。
 * @returns preset 名；未显式设置或读取失败为 null。
 */
async function currentPreset(): Promise<string | null> {
  const describe = await rpc('settings.describe', {})
  if (!describe.ok) return null
  const namespaces = (describe.value as { namespaces?: { ns: string; value: unknown }[] }).namespaces ?? []
  const permission = namespaces.find(entry => entry.ns === 'permission')
  const value = permission?.value as { defaultPreset?: unknown } | null
  return typeof value?.defaultPreset === 'string' ? value.defaultPreset : null
}

/**
 * 一次**请求提权**的 pwsh 工具调用参数。`sandbox_permissions` 与
 * `justification` 必须成对出现（缺一方在上游是 malformed ask），这一对
 * 才是抵达 user-approval 通道的入场券——只写越界路径不会触发审批，那条
 * 边界由 ACL 直接挡（见 S2）。
 * @param target - 要写的绝对路径（隔离临时根内，无害）。
 * @param content - 写入内容。
 * @returns mock LLM 要发出的工具参数。
 */
/**
 * 建一个**官方 UI 看得见**的会话。
 *
 * 审批面板渲染在会话页里，不是全局横幅。而官方 UI 的会话列表按 workspace
 * 分组：只给 `cwd` 建出来的会话不属于任何注册 workspace，界面上根本不
 * 渲染它，于是审批请求虽然真实发生（`approval/asked` 落在会话日志里），
 * 却永远没有可点的按钮。所以先 `workspace.create` 接纳这个目录，再按
 * workspaceId 建会话，最后 reload 让界面加载出该 workspace 并落在它的
 * 会话上。
 * @param app - 打包应用。
 * @param path - 要接纳为 workspace 的目录（隔离临时根内）。
 * @returns 新会话 id。
 */
async function createVisibleSession(app: ElectronApplication, path: string): Promise<string> {
  const workspace = await rpc('workspace.create', { path })
  expect(workspace.ok, `workspace.create 失败：${JSON.stringify(workspace.error)}`).toBe(true)
  await evalInView(app, COMP_URL_PREFIX, 'location.reload()')
  await waitForCompMount(app, 60_000)

  // 界面加载出该 workspace 后，会为它**预建一个空白会话并停在上面**——那
  // 正是审批面板要渲染的地方。所以不必去驱动输入框（实测也驱动不动：填进
  // textarea 的值不会进 React 状态，输入框保持空、发送键根本不渲染）。取
  // 界面自己建的那个会话，用官方 RPC 往里发 prompt 就够：界面本来就在它
  // 上面，审批一来就有地方显示。
  let sessionId = ''
  const wanted = path.split(/[\\/]/).filter(part => part !== '').at(-1) ?? path
  await expect.poll(async () => {
    const list = await rpc('session.list', {})
    if (!list.ok) return false
    const items = (list.value as { items: { sessionId: string; cwd?: string }[] }).items
    // 按 cwd 的末段匹配，不比整串：session.list 回的是长用户名路径，而
    // 隔离根用的是 8.3 短名，整串比较永远不等。
    const mine = items.find(item => (item.cwd ?? '').split(/[\\/]/).at(-1) === wanted)
    if (mine === undefined) return false
    sessionId = mine.sessionId
    return true
  }, { timeout: 60_000, message: '界面未为该 workspace 预建会话' }).toBe(true)
  return sessionId
}

function escalatingWrite(target: string, content: string): Record<string, unknown> {
  return {
    command: `Set-Content -Path '${target}' -Value '${content}'`,
    description: 'write outside the workspace after escalation',
    sandbox_permissions: 'danger-full-access',
    justification: '打包验收：在隔离临时目录里写一个哨兵文件，用于验证审批链路',
  }
}

/** 官方会话事件流（session.history 的投影页：`{ event, view? }` 条目）。 */
interface HistoryEntry { event: { type: string } }

/** 读官方会话事件流的当前类型序列——结算相位的唯一权威来源。 */
async function sessionEventTypes(sessionId: string): Promise<string[]> {
  const history = await rpc('session.history', { sessionId })
  if (!history.ok) throw new Error(`session.history 不可用：${JSON.stringify(history.error)}`)
  const events = (history.value as { events: HistoryEntry[] }).events
  return events.map(entry => entry.event.type)
}

/**
 * 等待工具执行完成后的真实结算相位：官方会话事件流中，工具确实被调用
 * （`tool/call` 出现过）之后出现 `turn/end`。两者都是 Harness 会话日志的
 * 持久事件，不是按钮消失或固定等待的近似——approval 面板消失但工具从未
 * 开始（例如 prompt 尚未入队）时，这里会等满超时并大声失败，而不是提前
 * 放行。
 * @param app - 打包应用（保留参数以保持与其它驱动一致；信号来自官方 RPC）。
 * @param sessionId - 被等待的官方会话。
 * @param timeoutMs - 结算等待上限。
 */
async function waitTurnSettled(_app: ElectronApplication, sessionId: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let sawToolCall = false
  for (;;) {
    const types = await sessionEventTypes(sessionId)
    sawToolCall ||= types.includes('tool/call')
    if (sawToolCall && types.includes('turn/end')) return
    if (Date.now() >= deadline) {
      throw new Error(`agent turn 未在 ${timeoutMs}ms 内结算（tool/call 已出现：${String(sawToolCall)}）`)
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

describe.runIf(packagedExists)('S2/S3/S6/S13 — 权限执行（打包态）', () => {
  let app: ElectronApplication | undefined
  let mock: MockLlmServer | undefined

  beforeEach(async () => {
    await ensureCleanStage()
  })

  afterEach(async () => {
    if (app !== undefined) {
      await shutdownApp(app)
      app = undefined
    }
    mock?.close()
    mock = undefined
  })

  async function launchWithMock(temp: string): Promise<ElectronApplication> {
    if (mock === undefined) throw new Error('mock LLM server 未启动')
    // Managed Home intentionally drops the host DEEPSEEK_API_KEY so the
    // official Models page can edit it. Seed the same credentials-local
    // document that page owns instead of bypassing the product policy.
    const dshHome = join(userDataDir(temp), 'dsh')
    mkdirSync(dshHome, { recursive: true })
    writeFileSync(
      join(dshHome, '.credentials.yaml'),
      'version: 1\nrefs:\n  DEEPSEEK_API_KEY: mock-key\n',
      'utf8',
    )
    const instance = await launchPackaged(temp, {
      env: {
        DEEPSEEK_BASE_URL: `${mock.baseURL}/v1`,
      },
    })
    app = instance
    await stubDialogs(instance)
    return instance
  }

  it('S2：越界写被 workspace-write 的 ACL confinement 硬拒绝——sentinel byte-identical、无兄弟文件、preset 不变、不 fallback Full Access', async () => {
    const temp = isolationRoot('s2')
    const outside = join(temp, 'outside-b')
    const workspaceA = join(temp, 'workspace-a')
    mkdirSync(outside, { recursive: true })
    mkdirSync(workspaceA, { recursive: true })
    writeFileSync(join(outside, 'sentinel.txt'), 'sentinel original\n')
    const sentinelBefore = readFileSync(join(outside, 'sentinel.txt'))

    // 普通 pwsh 工具调用（不请求提权）：向 cwd 之外的 sentinel 写内容。
    mock = await startToolMock({
      command: `Set-Content -Path '${join(outside, 'sentinel.txt')}' -Value 'pwned'`,
      description: 'overwrite the sentinel outside the workspace',
    })
    await launchWithMock(temp)
    const created = await rpc('session.create', { cwd: workspaceA })
    expect(created.ok, JSON.stringify(created.error)).toBe(true)
    const sessionId = (created.value as { sessionId: string }).sessionId

    void rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: '请按工具要求执行' }] })

    // 只等这一轮真实结算，绝不等 approval：Windows 上 workspace-write 的
    // 越界边界是 ACL confinement（见 @deepseek-ai/dsh-sandbox-windows-acl），
    // 受限进程根本不持有目标权限，OS 直接拒绝写入。审批是给"工具主动请求
    // 提权"用的（S6），一次普通越界写不必、也不保证经过它。
    await waitTurnSettled(app!, sessionId)

    // 本用例的全部意义就是这几条安全属性：
    expect(readFileSync(join(outside, 'sentinel.txt'))).toEqual(sentinelBefore)
    expect(readdirSync(outside)).toEqual(['sentinel.txt'])
    // 被拒绝不会让权限悄悄放宽：preset 绝不回落 Full Access。
    expect(await currentPreset()).not.toBe('danger-full-access')
  }, 300_000)

  it('S6a：请求提权触发真实 approval——UI 可见、未答前不执行、Deny 后动作不发生', async () => {
    const temp = isolationRoot('s6a')
    const outside = join(temp, 'outside-b')
    const workspaceA = join(temp, 'workspace-a')
    mkdirSync(outside, { recursive: true })
    mkdirSync(workspaceA, { recursive: true })
    writeFileSync(join(outside, 'sentinel.txt'), 'sentinel original\n')
    const sentinelBefore = readFileSync(join(outside, 'sentinel.txt'))

    // sandbox_permissions + justification 成对出现，才是真正抵达 Harness
    // approval policy 的那条路：workspace-write 预设 = sandbox 模式 +
    // ask 策略，escalation 在任何东西执行之前先经 user-approval 通道解析。
    mock = await startToolMock(escalatingWrite(join(outside, 'sentinel.txt'), 'escalated write'))
    await launchWithMock(temp)
    const sessionId = await createVisibleSession(app!, workspaceA)
    void rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: '请按工具要求执行' }] })

    // approval 真实可见：DeepCode 不自动批准，也不替用户作答。
    // 120s → 240s：这一步等的是完整 agent 回合（mock LLM 应答 → 工具调用 →
    // 审批卡渲染）。单跑整套只要 49 秒，全套连跑时机器满载，同一条要 120
    // 秒以上——2026-08-24 六套件跑齐时它是唯一的 flaky。超时按最坏负载给，
    // 否则这条会周期性假红、把真问题盖掉。
    await expect.poll(async () => approvalVisible(app!), { timeout: 240_000, message: 'approval UI 未出现' }).toBe(true)
    // 按钮文字不足以证明审批真的发生过——页面别处也可能出现"拒绝"二字。
    // 权威是会话日志：escalation 必须真的抵达过 user-approval 通道。
    expect(await sessionEventTypes(sessionId), '会话日志里没有 approval/asked：审批从未真正发生').toContain('approval/asked')
    // 用户还没答，动作就绝不能已经发生。
    expect(readFileSync(join(outside, 'sentinel.txt'))).toEqual(sentinelBefore)

    await clickApproval(app!, '拒绝')
    await waitTurnSettled(app!, sessionId)
    // 决定同样要落进日志：点了才算答过，DeepCode 不替用户产生这条记录。
    expect(await sessionEventTypes(sessionId), 'Deny 未落进会话日志').toContain('approval/decided')

    expect(readFileSync(join(outside, 'sentinel.txt'))).toEqual(sentinelBefore)
    expect(readdirSync(outside)).toEqual(['sentinel.txt'])
    // 拒绝一次不会把权限放宽，也不留下"下次别问"的痕迹。
    expect(await currentPreset()).not.toBe('danger-full-access')
  }, 300_000)

  it('S6b：Approve once 后该动作执行；approval/trust 状态仍归 Harness，DeepCode 不存第二份', async () => {
    const temp = isolationRoot('s6b')
    const outside = join(temp, 'outside-b')
    const workspaceA = join(temp, 'workspace-a')
    mkdirSync(outside, { recursive: true })
    mkdirSync(workspaceA, { recursive: true })
    writeFileSync(join(outside, 'sentinel.txt'), 'sentinel original\n')

    mock = await startToolMock(escalatingWrite(join(outside, 'sentinel.txt'), 'approved write'))
    await launchWithMock(temp)
    const sessionId = await createVisibleSession(app!, workspaceA)
    void rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: '请按工具要求执行' }] })

    // 120s → 240s：这一步等的是完整 agent 回合（mock LLM 应答 → 工具调用 →
    // 审批卡渲染）。单跑整套只要 49 秒，全套连跑时机器满载，同一条要 120
    // 秒以上——2026-08-24 六套件跑齐时它是唯一的 flaky。超时按最坏负载给，
    // 否则这条会周期性假红、把真问题盖掉。
    await expect.poll(async () => approvalVisible(app!), { timeout: 240_000, message: 'approval UI 未出现' }).toBe(true)
    await clickApproval(app!, '允许一次')
    await waitTurnSettled(app!, sessionId)

    // 用户批准了，动作才发生（trim：Set-Content 会补一个行尾）。
    expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8').trim()).toBe('approved write')
    // 授权归 Harness：DeepCode 的 userData 下没有任何 approval/trust 存档，
    // "允许一次"就只是一次，绝不由 DeepCode 记成长期信任。
    expect(readdirSync(userDataDir(temp)).filter(name => /approval|trust/i.test(name))).toEqual([])
  }, 300_000)

  it('S3：工作区内写入经允许路径成功（workspace-write 不禁止区内操作）', async () => {
    const temp = isolationRoot('s3')
    const workspaceA = join(temp, 'workspace-a')
    mkdirSync(workspaceA, { recursive: true })

    mock = await startToolMock({
      command: `Set-Content -Path '${join(workspaceA, 'inside.txt')}' -Value 'inside ok'`,
      description: 'write a file inside the workspace',
    })
    await launchWithMock(temp)
    const created = await rpc('session.create', { cwd: workspaceA })
    expect(created.ok, JSON.stringify(created.error)).toBe(true)
    const sessionId = (created.value as { sessionId: string }).sessionId

    void rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: '请按工具要求执行' }] })

    // 区内写不需要 approval；文件最终出现且内容完整（存在性与写入完成
    // 是同一相位，只等 exists 会在文件尚未写完时读到半截内容）。
    // trim：Set-Content 按 PowerShell 语义补一个行尾，本用例要证明的是
    // "沙箱内的写入真的落盘且正文正确"，不是行尾字节。
    await expect.poll(async () => {
      try {
        return readFileSync(join(workspaceA, 'inside.txt'), 'utf8').trim()
      } catch {
        return null
      }
    }, {
      timeout: 120_000,
      message: '工作区内写入未生效',
    }).toBe('inside ok')
  }, 300_000)

  it('S13：无害 sandboxed PowerShell 动作执行成功，执行期间不出现可见 pwsh 控制台窗口', async () => {
    const temp = isolationRoot('s13')
    const workspaceA = join(temp, 'workspace-a')
    mkdirSync(workspaceA, { recursive: true })

    mock = await startToolMock({
      command: `Set-Content -Path '${join(workspaceA, 'probe.txt')}' -Value 'harmless probe'`,
      description: 'harmless write inside the workspace',
    })
    await launchWithMock(temp)
    // 执行前基线：可见 pwsh 窗口集合。
    const before = new Set(sampleVisiblePwshWindows())
    const created = await rpc('session.create', { cwd: workspaceA })
    expect(created.ok, JSON.stringify(created.error)).toBe(true)
    const sessionId = (created.value as { sessionId: string }).sessionId

    void rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: '请按工具要求执行' }] })

    // 执行期间连续采样（黑框检测窗口）。
    const deadline = Date.now() + 120_000
    const seen: string[] = []
    for (;;) {
      for (const line of sampleVisiblePwshWindows()) {
        if (!before.has(line)) seen.push(line)
      }
      if (existsSync(join(workspaceA, 'probe.txt'))) break
      if (Date.now() >= deadline) throw new Error('S13 工具执行未在时限内完成')
      await new Promise(resolve => setTimeout(resolve, 400))
    }
    // trim 同 S3：Set-Content 补的行尾不是本用例要证明的东西。
    expect(readFileSync(join(workspaceA, 'probe.txt'), 'utf8').trim()).toBe('harmless probe')
    // 黑框断言：执行期间没有出现新的可见 pwsh 控制台窗口。
    expect(seen, `出现新的可见 pwsh 窗口：${seen.join(', ')}`).toEqual([])
  }, 300_000)
})
