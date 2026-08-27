# Agent Note：DeepSeekGUI B2-P6 — Windows V1.0.0 最终发布门禁

Status: implemented

[English](2026-08-19-deepseekgui-b2-p6-release-safety.md) | 中文

## 问题

P6 是 V1.0.0 之前的最后一个 Windows 产品门禁。四类发布级风险此前没有答案：一次 GUI 发起的插件变更即使安装成功、post-check 成功，仍可能把下一代 Harness 搞坏且没有可验证的恢复路径；权限状态不可见、Full Access 无法被"确认框"挡住误触（Harness 是唯一权限真相源——DeepSeekGUI 绝不允许长出第二份）；GUI 完全起不来时没有任何 headless 取证出口；packaged GUI 也缺少工作区选择、sandboxed PowerShell 与主题控制在真实 Windows 上正确的证据。冻结规格源为 `DEEPSEEKGUI_B2_P6_WINDOWS_RELEASE_SAFETY.md`（P6 唯一规格源）。

## 决策

**P6-0——继续钉 embedded DSH rc.5。** rc.5 → rc.7 定向审查（fork 点 `47f943859b` → 上游 tag `dsh-v0.1.0-rc.7`）按规格 §4 的格式存档于此：

P6-required delta:
- 无。`user-approval`、`permission-presets`、`tool-sandbox-modes`、`pwsh-sandbox`、`sandbox-policy`、`sandbox-windows-acl`、`directory-picker*`、`client/runtime`、`ui-permission-presets` 的 `src` 在 rc.5 → rc.7 之间只有 package.json 版本号变化。`permission` 与 `ui-theme` 两个 settings 命名空间在 rc.5 的暴露名单（`WEB_SETTINGS_NAMESPACES`）里就已存在，P6 的 `settings.mutate` 权限/主题路径在 rc.5 上完全可用——rc.7 对 P6 不提供任何新增能力。

Non-blocking delta:
- settings 面重构（plugin-owned settings surface：硬编码暴露名单改为按注册暴露，删除 `settings-not-exposed` 错误码）；
- 图片附件批处理（`saveImages`）与 read-image `deferContext` 移除；
- 大历史分页 `groupStart` 修复；
- ACP 协议重构与 MCP 客户端工具扩展；
- LLM adapter 变化（DeepSeek 新增 `low` 推理档位；pi-ai replay 重写）；
- 客户端 UI（插件配置页、问卡片折叠、Safari textarea 重排、输入栏）；
- node-pty patch 1.1.0 → 1.2.0-beta.15（终端线，非 P6 面）。

以上均不触及 P6 的 permission / approval / sandbox / theme / workspace 验收面。

Upgrade verdict:
- keep rc.5。无 P6 必需安全修复、无已确认的打包态 Windows 正确性 bug、无 P6 专属 API；§4 升级规则禁止为对齐版本升级。

**权限——Harness 是唯一真相源，DeepSeekGUI 只读只显示。** 一个最小的官方 RPC 客户端（`harness-api.ts`，`POST /api/<method>` 携带官方 client-request 信封、仅 loopback、严格解析）读 `settings.describe`、写 `settings.mutate`——与 Web UI 走的是同一个官方 settings service。`permission-view.ts` 把官方 `permission.defaultPreset` 映射为显示模式（`workspace-write`→Sandbox、`danger-full-access`→Full Access、`read-only`→Read-only，其余 Custom；namespace 缺失/读取失败 → unavailable，fail-closed）。Harness 面板显示真实模式，`Enable Full Access` 必须显式风险确认，Existing Home 只读显示（切回 Sandbox 先确认；Cancel 零写入），全新 Managed Home 仅在官方没有明确默认值时经官方 API 写入推荐预设。Agent 审批保持 Harness 原生行为——DeepSeekGUI 绝不自动批准、不维护信任缓存。

**主题——官方 settings service，绝不编辑 YAML。** 删除了 Electron 侧的 `writeHarnessThemePreference` YAML 编辑；主题偏好写入改走 `settings.mutate` 的 `ui-theme.preference`（官方热发布路径）。壳仍在启动早期读官方文档（服务未起时）并 watch，只消费解析后的 light/dark。`desktop-ui-state.json` 的 `themePreference` 保留为 ignored legacy 字段（P6 禁止为一个字段做 schema migration）。绝不复活 insertCSS / MutationObserver / DOM 标记抢写。

**Plugin Mutation Recovery——一个窄 journal + 三个文件快照，仅此而已。** 每次经确认的 GUI 写操作（add/remove/update/install）对 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` 三个白名单文件做 byte-identical 快照 + SHA-256（不存在记录 absent，绝不伪造空文件），存到 `userData/plugin-recovery/snapshots/<txId>/`，journal（`plugin-recovery.ts`，严格解析）只存在 DeepSeekGUI userData。写路径本身仍只走官方 `dsh plugin` CLI。post-check 成功后 journal 进入 `pending-verification`；同一 Home/Profile 同时最多一个 pending 未验证事务；Restart Later 保留 journal。「下一代健康」不是"端口有响应"：boot 现在要求 HTTP 就绪 + 官方 UI 挂载 + DeepSeekGUI 主题 client 插件 settle（其 `apply` 设置 `window.__deepseekguiClientSettled`，宿主在 `loadURL` 后轮询）。下一代 boot 失败时先核对 post hash——任一白名单文件在事务后被外部修改（drift）即停止恢复，只给人工入口（打开 Profile 文件夹 / 打开 DSH 终端 / 放弃），绝不覆盖。无 drift 时 Managed Home 恢复三个文件并最多重启一次（第二次仍失败停止自动动作，应用保持存活显示恢复区块而不是 fail-loud 退出）；Existing Home 未经明确确认（列出将恢复的具体文件）绝不恢复。`node_modules` 从不备份、从不恢复；没有事务数据库。

**崩溃证据与 headless 诊断。** `DeepSeekGUI.exe --export-diagnostics` 在单实例锁之前运行，不启动 Harness/profile/插件/窗口/tray/3080/update/recovery：组装同一份 allowlist bundle（脱敏日志 + 轮转历史、build info、上次退出事实、本地 Crashpad `.dmp` 总量 50 MB 有界——最新优先、被跳过的如实记入 manifest），路径打到 stdout 后退出（60 秒上限，失败非零退出码）。`active-run.json` marker 启动时写、正常退出（`proceedQuit`）时删除——残留 marker 是"上次未正常退出"的最小证据，绝不自动断言 crash、绝不删除数据。`crashReporter.start({ uploadToServer: false, submitURL: '' })` 只收集本地 dump；导出对话框带 dump 隐私提示。

**工作区选择——DeepSeekGUI 零自有代码。** 官方 Harness Workspace UI（ui-workspace + directory-picker-auto → Windows 上的 native IFileOpenDialog）原样使用；DeepSeekGUI 不建任何 workspace registry 或 bridge。打包验收（S12）驱动官方 Add-workspace 入口选择「中文 workspace with spaces」目录，系统对话框经 UIAutomation 辅助脚本（`tests-e2e/fixtures/drive-open-dialog.ps1`）自动化。

**Sandboxed PowerShell 控制台窗口。** 上游 `subprocess-local` 的 spawn 层保持不动：最初的 `windowsHide` 改动在验收返工中恢复（这两个文件属上游所有——首次提交 2026-07-26/07-28，远早于 B1——不改上游铁律适用；技术方向是对的，落点错了）。黑框问题改由 S13 的打包态实测回答：在一次无害 sandboxed 工具动作执行期间采样可见 pwsh 控制台窗口（进程名 + 创建时间）。若确认出现持续可见控制台，修复应落在 DeepSeekGUI 自己的进程创建路径（desktop 的 DSH 服务 spawn / 整树终止器）；若根因只在上游 spawn 行为，则记录为挂账 + 上游 PR 候选，绝不改上游文件。sandbox 后端的 confinement 层绝不为好看而动。

**PS7 与插件易用性。** 终端宿主探测改为 Windows Terminal → PowerShell 7（Program Files + Store 别名）→ PowerShell → cmd；PS7 只是用户终端推荐项——面板一行非阻塞提示（含 winget 命令），绝不自动安装，Agent 沙箱路径绝不参考它。Plugin Manager 增加「如何安装插件」帮助块，如实说明 DeepSeekGUI 不经营插件市场。

## 备选方案

- **把 embedded DSH 升到 rc.7**：按 P6 升级规则拒绝——无 P6 必需安全修复、无已确认打包态正确性 bug、无 P6 专属 API；审查证据记录在交付报告。
- **给 Managed Home 的启动 env 注入 `DSH_PERMISSION_MODE=read-only`**：拒绝——规格的「Sandbox」对应上游安全预设 `workspace-write` + ask（S3 要求工作区内写入可用，read-only 会把它挂掉），且规格要求"读取并显示 Harness 真实 preset"，不是对抗 composition。env 覆盖是上游的部署配置语义：用户系统若设了 `DSH_PERMISSION_MODE=danger-full-access`，那这就是 Harness 的真实 preset，DeepSeekGUI 如实显示 Full Access，绝不静默掩盖。
- **DeepSeekGUI 自有 permission store / trust 数据库 / 命令风险分类器**：拒绝——P6 禁止第二份权限真相；读 + 显示官方 settings service 已覆盖可见性与切换。
- **为权限切换直接编辑 settings.yaml**：拒绝——官方 settings API 就在 loopback（`settings.mutate`），带 namespace revision 语义并热发布；YAML 编辑正是 P6 移除的主题过渡债，不是该重复的模式。
- **插件恢复造通用事务引擎或包管理器**：被 Ponytail 规则拒绝——一个窄 journal + 三个白名单快照就是全部机制。
- **自动恢复循环 / 备份 node_modules**：拒绝——Managed Home 最多一次自动恢复+重启，Existing Home 确认门控，drift fail-closed，绝不碰 `node_modules`。
- **DeepSeekGUI 自建 workspace picker bridge**：拒绝——官方 picker 在 Windows 可用（native 路径、loopback 宿主）；门禁是 S12 打包测试，只有它失败才允许规格允许的最薄 bridge。
- **用关沙箱 / Full Access / 用户终端来隐藏控制台窗口**：拒绝——修复落在 Windows 进程创建层，沙箱与 stdio 捕获完好。

## 后果

- `apps/desktop` 单测从 521 涨到 579（29 个文件），新增纯模块：`harness-api`、`permission-view`、`crash-evidence`、`plugin-recovery`。
- 主题写入、权限读写、插件恢复 journal 全部流经 Harness 拥有的表面；DeepSeekGUI 自有状态仍只有 launcher state + UI state + 恢复 journal + 更新缓存。
- 坏插件变更不再能把 Managed Home 留在死 profile：快照 → post-check → pending 验证 → 下一代健康（HTTP + UI + client settle）→ verified，或恢复 → 重启（一次）→ recovered / 人工恢复；Existing Home 与 drift 都 fail closed 到人工入口。
- GUI 起不来也有受支持的取证路径（`--export-diagnostics`）；打包验收 S1–S13（`tests-e2e/permission-ui.e2e.ts`、`permission-execution.e2e.ts`、`plugin-recovery.e2e.ts`、`headless-diagnostics.e2e.ts`、`workspace-picker.e2e.ts`）已写入，可用重建后的包重跑。

## 验收阶段注意事项

- 打包 S 套件需要全新构建的 `dist/desktop/win-unpacked/DeepSeekGUI.exe`（验收返工后已重建过一次；最终重建属于验收阶段）。在返工后的包上：S1/S4/S5/S7-8（permission-ui）PASS、S11（headless 诊断）PASS、S10a/S10c（插件恢复）PASS——S10a 到达 `recovered` 且白名单文件 byte-identical，S10c 经确认恢复走完 `recovery-needed → recovered`。S2/S3/S6/S13、S9、S10b、S12 的测试代码已修复，下次重建后可重跑（逐项证据见返工交付报告）。
- 验收返工抓到并修复了一个产品真 bug（恢复结算时机）：`settlePluginRecovery` 曾挂在每个控制命令之后运行，且 Harness running 时会把 running 状态的 journal 直接 clear——实测在途 add 的 journal 在 post-check 前被误清、Restart Later 后任意命令会把 pending 事务误 verified。修复后 settle 只对 boot 型命令（`switch-profile`/`restart-harness`/`use-managed-home`）结算，boot 健康分支按纯函数 `bootHealthySettleAction` 判定（pending-verification→verify；running→残留清理或保持；recovery-needed/drift→keep），`pluginOperationInFlight` 区分在途与崩溃残留。
- S2/S3/S6/S13 经官方 RPC 用 repo 内 mock LLM（`@deepseek-ai/dsh-llm-mock-server`，`tool_call_success` → pwsh）跑真实 agent；`waitTurnSettled` 改为等待官方 `session.history` 事件流的真实相位（`tool/call` 出现过 + `turn/end` 出现），不再是按钮消失近似。审批经官方 UI 按钮（拒绝 / 允许一次）应答；黑框断言在执行期间采样可见 pwsh 窗口（进程名 + 启动时间）。destructive 断言只在隔离临时根内。
- S12 经 `tests-e2e/fixtures/drive-open-dialog.ps1`（UIAutomation；中英文按钮名都匹配，另加官方 `Select Workspace Directory` 标题；脚本为 UTF-8 WITH BOM——PowerShell 5.1 把无 BOM 的 UTF-8 按 ANSI 解码，非 ASCII 字节会吞掉后面的行）驱动 native IFileOpenDialog。
- 本机环境全局设置了 `NODE_ENV=production`，会破坏仓库的 jsdom 套件（React `act()` 与 vite node-external 处理）；本地单测全部用 `$env:NODE_ENV='test'` 跑。CI 没有这个变量。
- `packages/subprocess/subprocess-local` 保持上游原样（返工 R1 已把 `windowsHide` 改动恢复到 HEAD）；黑框问题由打包态 S13 实测回答，其自身 spec 按既有配置在 win32 被排除。
- `vitest.desktop-parity.config.ts` 补了 tsconfigPaths 插件：permission-execution 套件 import 的 `@deepseek-ai/dsh-llm-mock-server` workspace 包否则在此 config 下无法解析，文件会静默收集失败（0 个测试）。
