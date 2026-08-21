# Agent Note：DeepCode B2-P3 —— Harness-native Profile/Plugin Manager v1

状态：已实施

[English](2026-08-17-deepcode-b2-p3-plugin-manager.md) | 中文

## 问题

桌面端此前只有 profile 切换，没有插件管理：用户可以启动 profile，但看不到它的组成，也无法增删插件。P2 的 Desktop Command Broker 是全局单槽，而常驻终端的 pty host 会占用该槽整个生命周期——终端开着时任何插件写操作都会吃 `DesktopCommandBusyError`。插件事实散落各处（profile manifest、官方 CLI 输出、pnpm 真实结果），没有 UI 区分"package.json 里声明了"与"真的加载了"，也没有任何东西防止一次写入静默破坏用户现有的 Harness Profile。

## 决策

**一条官方路径，不建第二份插件存储。** Plugin Manager 不建立 plugin database。展示事实只来自三个来源：B1 的 `dsh profiles --json` discovery（`bundles` 层、`staticStatus`/`evidence`）、profile `package.json` 的 `dependencies`（只读文档）、官方 CLI 自己的分类。UI 渲染三个绝不混写的区——Profile Bundles（模板与依赖派生用 `dependencies` 键交叉区分）、已安装依赖（逐条标注是否已进 bundles 层）、Effective/Loader 事实——依赖没加载成功就绝不显示成已加载。所有写操作走官方 `dsh plugin --profile <target> <pnpm args...>` grammar（对照 `apps/cli/src/args.ts` 与 `plugin.ts` 核实）：exact argv 经 broker（绝不 shell string）、`DSH_HOME` 来自 launcher selection、PATH 前置 P2 的私有 shim 目录，使官方 CLI 内部的 `pnpm` spawn 解析到私有 Runtime 而非系统 pnpm。`install`/`repair` 即官方 `pnpm install` 转发（pnpm 无独立 `repair`；CLI 自己的错误文案推荐的正是这条路径）。

**两个独立 broker 槽位。** `desktop-command.ts` 把全局单例 `active` 改为按槽持有：`terminal`（常驻 pty host）与 `maintenance`（插件操作）各最多一项、互不阻塞；同槽并发仍抛 `DesktopCommandBusyError`。无队列、无重试、无并发管理器。

**目标透明度与零写入浏览。** 每次写操作前弹确认对话框：Home kind、完整解析路径、Profile、操作、spec；Existing Home 额外显示"这次操作会修改你选择的现有 Harness Profile。"（抽成纯函数 `pluginConfirmText`，双语单测）。发现、浏览、刷新零写入；只有用户明确确认的管理动作才写目标 Profile。v1 目标仅限 active Home 下已发现、非 malformed 的 profile（官方 CLI 对缺失 profile 会 auto-init；desktop 选择拒绝，跨 Home 写不在范围）。

**Operation model。** 同一目标同一时刻一个操作，走 maintenance 槽：输出流式脱敏（限长 300 行 / 64KB）、实时步骤（运行中 → 验证中 → 完成/失败/已取消）、Cancel 杀完整子进程树、exit 0 是 post-check 的唯一入口——post-check 从磁盘重读 discovery + manifest 验证预期变化（add：包名或任一新依赖出现；remove：消失；update：版本串变化或如实报告已最新；install：discovery 仍可解析）——随后刷新 inventory 并出现 Restart Now / Later 提示（"插件变更已完成，需要重启 Harness 才会进入新的 Loader composition。"）。Restart Now 复用唯一 `controller.restart()` 路径；Later 只关提示、绝不假装新组合已加载。失败绝不触碰 active Profile 或 launcher selection（操作只经官方 CLI 写 profile 目录）。

**本地 package spec 与 desktop 侧 pre-check。** 相对 spec（`./`、`../`、`file:`/`link:` 前缀）锚定到用户选择的目录（相对形态在确认前先弹目录选择器；绝不锚到 Electron install dir）。每个 spec 都是单个 argv 元素。两个上游事实被真实 spawn 测试钉死并在 desktop 边界防御：pnpm `add` 不存在的目录 exit 0 却写入 `link:` 依赖（所以 `validateLocalSpecTarget` 预检存在性 + 是目录），官方 CLI 在 Windows 上 `shell: true` 转发 pnpm 会拆开含空格的路径参数（所以含空白的 spec 直接拒绝并说明原因，而不是绕开）。

## 备选方案

- **插件数据库或 GUI 自己解析组合**：拒绝——第二份存储必然漂移；官方 CLI 的 reconcile 已经拥有 `dsh.profile.bundles`，desktop 应展示 CLI/manifest 事实而非自己的。
- **手改 `package.json` / `dsh.profile.bundles` / 复制 node_modules / 直接调 pnpm**：拒绝——施工单禁止发明低层写入路径；每次写入都骑官方 `dsh plugin` 的 reconcile。
- **给 broker 加队列**：施工单禁止——两个独立槽位（终端会话 vs 维护操作）表达了真实并发，无需排队。
- **支持跨 Home 目标或 auto-init 缺失 profile**：v1 拒绝——`DSH_HOME` 只有 launcher 一个来源，名字打错时静默建 profile 违背目标透明度。
- **把含空格本地路径编码成 `file:` URL**：拒绝——上游 CLI 无论如何都无法转发它们，desktop 层的编码把戏等于声称官方路径没有的能力。

## 后果

- 终端与插件操作可以并发；resident-host note 里记录的 P2 BusyError 张力在不加队列的前提下解除。
- 用户可以看清 profile 的组成（三种互不混淆的事实类），并带目标确认、流式进度、取消、磁盘验证 post-check 与诚实重启提示地增删改插件——绝不自动重启、绝不伪造已加载。
- 真实 spawn 测试（repo-local fake bundle 包，无网络、无模型、无凭据）端到端锁住官方 grammar：add/remove 改变 manifest 与 bundles、Unicode 路径作为单个 argv 元素完整解析、仅含私有 shim 的干净 PATH 即可用、inactive explicit profile 目标隔离、install 保持 discovery 可解析，且两个上游坑（缺失目录静默 `link:`、空白拆分）都固化为证据。

## 给验收阶段的验证提示

- 目标透明度确认是主进程 `dialog.showMessageBox`（`apps/desktop/src/main.ts` 的 `confirmPluginOperation`）；`DSH_DESKTOP_SMOKE=1` 会跳过它，但 smoke 模式同时会关窗退出——打包验收若要自动化驱动插件 UI，要么处理该对话框（主进程 `dialog` 可从 playwright 的 `app.evaluate` 上下文 monkeypatch），要么把插件流程验收放在人工 UI 审查（P1 控制面审查的先例）。
- 单写互斥覆盖整个请求生命周期：确认框打开期间（`pluginRequestInFlight`）、操作运行中、post-check 结算中，第二个请求一律拒绝；终态视图（done/failed/cancelled）允许下一轮操作，且新操作只有在自己的确认通过后才替换视图。
- 真实 spawn 测试经 `npm_execpath`（pnpm script 注入）或 corepack 缓存探测 pnpm，两者都缺失时整组跳过；请经 `pnpm run test` 运行以便整套执行。

## 施工单逐节核对表

| 施工单节 | 实现 | 证据 |
|---|---|---|
| 一、官方语义验证 | `apps/desktop/src/plugin-service.ts`（`buildPluginOperationArgs`，对照 `apps/cli/src/args.ts`/`plugin.ts` 语义）；开工报告（上文） | `tests/plugin-service.spec.ts` argv 形态 + `tests/plugin-real-spawn.spec.ts` 真实 CLI 运行 |
| 二、唯一事实源、三分类 | `buildPluginInventory`（bundles 来自 discovery、dependencies 来自只读 manifest、effective 来自官方 `staticStatus`/`evidence`；模板与依赖派生按 `dependencies` 键交叉） | `plugin-service.spec.ts`"三分类绝不混写" + 真实 spawn 的 manifest/bundles 断言 |
| 三、目标透明度与 Existing 边界 | 纯函数 `pluginConfirmText` + `confirmPluginOperation` 对话框；Existing 显示施工单要求的原句；零写入浏览（只 discovery/manifest 读） | `plugin-service.spec.ts` `pluginConfirmText`（Managed/Existing、中英）；`profile-discovery.spec.ts` 零写入 |
| 四、只走官方 `dsh plugin` 路径 | broker maintenance 槽 spawn `resolveDshCommand` + `buildPluginOperationArgs`，PATH 前置 P2 私有 shim；全库无手改 manifest/bundles/node_modules | "main 接线形态" argv 断言（无父级 `--profile/--host/--port`）；干净 PATH 真实 spawn |
| 五、Operation model | `main.ts` 的 `requestPluginOperation`/`settlePluginOperation`：单写互斥（`pluginRequestInFlight` + maintenance 槽）、流式脱敏输出（300 行/64KB 上限）、Cancel 杀树、exit 0 → post-check → 刷新 → handoff；失败不碰 launcher selection | `plugin-service.spec.ts` post-check 矩阵；`desktop-command.spec.ts` cancel/槽位；真实 spawn 的 nonzero/缺失目录证据 |
| 六、Restart handoff | `shouldShowHandoff`（exit 0 + post-check ok）→ 横幅 Restart Now（复用 `restart-harness` → `controller.restart()`）/ Later；绝不自动重启 | `plugin-service.spec.ts` handoff 条件；`control-dispatch.spec.ts` 命令路由（调度器自身绝不 restart） |
| 七、本地 package spec | `anchorLocalSpec`（与官方 `anchorPathSpec` 同一语法面，锚到用户选择目录）；`validateLocalSpecTarget` 预检存在性 + 是目录（pnpm 对缺失目录静默写 `link:` 且 exit 0）；含空白 spec 边界拒绝（官方 CLI Windows `shell:true` 拆词——真实 spawn 证据钉死） | `plugin-service.spec.ts` 锚定/校验；`plugin-real-spawn.spec.ts` Unicode 路径 + 缺失目录 `link:` 证据 |
| 八、v1 UI | Desktop Chrome 的 Harness 面板二级页面（`src/chrome/index.html` + `renderer.ts` `renderPluginView`）：target 选择（malformed 禁用）、三区 inventory、四操作 + spec 输入（Enter 提交）、运行步骤 + 可展开输出 + Cancel、handoff 横幅；无 Marketplace/推荐/远程目录 | 人工 UI 审查；zh/en 文案字典 |
| 九、核心测试 | desktop 414 测试全绿，含 7 个真实 spawn（repo-local fake bundle 包，无网络/模型/凭据）；B1 real Cordis plugin proof 回归绿；lint/typecheck/doc-sync/diff-check 干净 | `pnpm run test` + `pnpm run doc-sync` |

施工单之外追加：broker 槽位拆分（`terminal`/`maintenance`，解除 P2 deferred 的 BusyError 张力）、boot 阶段守卫（启动/切换/恢复读 manifest 期间拒绝插件写）、取消后刷新磁盘事实、诚实取消文案、IPC 限长（profile ≤256、spec ≤4096）。

## 上游差异（upstream delta）

**根因在上游：`apps/cli/src/plugin.ts` 以 `shell: process.platform === 'win32'` 转发 pnpm**（为解析 `pnpm.cmd` shim 而开）。Node 在 `shell: true` 下不转义参数，于是 cmd 既解释空白（拆词——已由真实 spawn 证据钉死），也解释 shell 元字符（`& | < > ^ % ! " ' \` ( ) ; ,`）。验收方探针 `bogus-pkg-xyz&echo.>INJECTED.txt` 在目标 profile 目录写出标记文件且退出码 0。因此 desktop 在边界拒绝一切携带这些字符或控制字符的 spec（`validatePluginRequest`），口径与空白拒绝同样诚实：这是官方 CLI 的 Windows 转发限制，不是 DeepCode 的产品选择。

语义后果：含 `|` 或 `>` 或空格的 semver 复合范围（`"1.x||2.x"`、`">=1 <2"`）不支持，插入符范围（`^1.0.0`）同样拒绝——探针实证：`cmd /c echo pkg@^1.0.0` 输出 `pkg@1.0.0`，cmd 吞掉 ^，把范围悄悄改写成精确版本（语义篡改，同一注入面的另一形态）。波浪号与精确版本原样通过。持久修法属于上游（解析出 pnpm 的 `.cmd` 路径后 `shell: false` 直 spawn，或 `execFile` + 显式转义）；出口按 B1 两条路（上游 PR 或 DeepCode Core adapter）；B2 不改上游。

"spec 是单个 argv 元素"的单测也已改名，不再宣称其断言范围覆盖不到的"无 shell 注入面"结论——安全断言由边界拒绝测试承担，并新增一条真实 spawn 测试故意对官方 CLI 喂注入 payload、断言标记文件出现，钉死"边界校验为何必须存在"。

## 暂缓

- Marketplace、推荐、远程目录、评分、"热门"列表：明确不在 v1。
- 跨 Home 插件目标与缺失 profile 的 auto-init：launcher state 只拥有一个 active Home；多 Home 管理属后续 package。
- DSH_HOME 路径含空格会以同样方式（pnpm 转发经 Windows shell）破坏官方 CLI 的本地路径 add；desktop 侧暂只做 spec 级拒绝，长期修复属上游或后续 CLI 演进。
- handoff 提示为会话级（不落盘）；真实重启后新组合自然生效，无需跨启动确认。

- Marketplace、推荐、远程目录、评分、"热门"列表：明确不在 v1。
- 跨 Home 插件目标与缺失 profile 的 auto-init：launcher state 只拥有一个 active Home；多 Home 管理属后续 package。
- DSH_HOME 路径含空格会以同样方式（pnpm 转发经 Windows shell）破坏官方 CLI 的本地路径 add；desktop 侧暂只做 spec 级拒绝，长期修复属上游或后续 CLI 演进。
- handoff 提示为会话级（不落盘）；真实重启后新组合自然生效，无需跨启动确认。

## 验收补充（验收方）

**经上游 Windows shell 转发的命令注入。**官方 CLI 使用 `spawnSync('pnpm', args, { shell: process.platform === 'win32' })`（为解析 pnpm 的 `.cmd` shim 而做的既有变通），Node 在该模式下不转义任何元字符。验收方探针实证了两次真实执行，且都退出 0：

- 直接输入的 spec `bogus-pkg-xyz&echo.>INJECTED.txt` 在目标 profile 目录写出该文件；
- spec 层修好后，锚定目录名 `p&copy nul INJECTED2.txt&rem` 配干净 spec `./local` 依然造成任意命令执行——真正进 argv 的是锚定结果，不是用户输入。

因此 desktop 边界对**用户输入与锚定结果同时**拒绝空白、cmd 元字符（`& | < > ^ % ! " ' \` ( ) ; ,`）与控制字符（`unsafeForWindowsShellForward`）。由此产生的取舍全部是上游转发方式所迫，不是产品选择：插入符范围（`^1.0.0`）被拒，因为 cmd 会吞掉 `^` 并把范围悄悄窄化成精确版本；含 `|`、`>` 或空格的复合 semver 范围不支持；本地插件必须放在不含这些字符的路径下。持久修法属于上游（解析出 pnpm 的 `.cmd` 路径后 `shell: false` 直 spawn，或 `execFile` + 显式转义），出口沿用 B1 已定的 upstream-delta 两条路；B2 不改上游。

**post-check 必须用 manifest 的语言说话。**`update pkg@^2.0.0`（校验层明确接受的形态）此前把整个 spec 当 manifest 键，导致一次成功的更新被报成"退出 0 但与磁盘事实不符"并扣下 restart handoff。现在 `update` 与 `remove` 都先经 `expectedPackageName` 取裸包名再比对快照。

**打包插件验收**（`tests-e2e/plugin-manager.e2e.ts`）经 production 控制入口驱动打包 exe，fixture 是一个 `apply` 时写 marker 的真 Cordis bundle 包：add → post-check 通过（manifest + bundles 同时变化）、**Restart Later 时 marker 不出现**（新 composition 确实尚未加载）、**Restart Now 后 marker 出现**（composition 真的生效）、remove 复原 profile，且 Existing Home 的 sentinel 与非目标 profile 字节不变。原生确认对话框仅在测试侧 stub，production 代码零测试后门。
