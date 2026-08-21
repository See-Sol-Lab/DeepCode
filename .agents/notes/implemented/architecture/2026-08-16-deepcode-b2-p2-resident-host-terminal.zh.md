# Agent Note: DeepCode 常驻宿主、托盘与内嵌 DSH Terminal

Status: implemented

[English](2026-08-16-deepcode-b2-p2-resident-host-terminal.md) | 中文

## Problem

桌面此前是单窗口形态：关窗即杀应用与 DSH 进程树，DSH 意外崩溃只弹一个干巴巴的错误框并杀死整个应用；没有托盘、没有终端，也没有桌面侧的命令执行层。常驻宿主需要四种边界分明的退出语义（窗口 X、显式 Quit、OS 关机/注销、意外子进程退出），需要一个绝不建立第二份 selection/运行状态的托盘，以及一个 Node/pnpm/DSH 都真实从打包 Runtime 执行的终端——不碰系统 PATH、注册表或 shell 配置。

## Decision

**单一生命周期。** 窗口是常驻表面：X 只是隐藏（`quitting` 为假），Harness 继续运行；首次隐藏时用一次性非阻断托盘气泡说明 close-to-tray，确认位存为 UI state 的 `closeToTrayNoticeAcknowledged`（schema v2）。Quit DeepCode（托盘或 chrome 菜单）是唯一真正退出：诚实确认——「退出 DeepCode 会停止 Harness，并中断当前正在执行的任务（如果有）。」，绝不虚假声称检测到任务——然后 `quitting = true`、`controller.stop()`（完整进程树 kill + 等待清理）、销毁托盘/视图、`app.quit()`。第二个实例显示并聚焦已有窗口（绝不启动第二个 Harness）。OS 关机/注销走窗口级 `query-session-end`/`session-end` 事件（Electron 43 把它们从 app 移到了 window）：不 `preventDefault`，经同一 `proceedQuit` 路径做无交互 orderly cleanup。

**唯一状态来源。** `HarnessController.notifyUnexpectedExit(message)` 是运行中崩溃的唯一入口：把内存状态置为 `failed`（stage `runtime`——`BootStage` 新成员，绝不写入 launcher state，落盘的 `lastBootFailure` 保持三阶段语义），不回退、不自动重启、不写盘。main 的 exit 监视只转发脱敏诊断，别无他物。Restart Harness 复用既有 `restart()`。

**唯一控制路径。** 托盘菜单是纯模板（`tray.ts`），从与 chrome 相同的 `buildControlModel()` 快照构建并在每次 broadcast 重建：打开 DeepCode、只读当前 Profile、实时 Harness 状态、Profiles 快速切换 radio 子菜单（仅可启动项）、Restart Harness、Open Harness Panel（经窄 renderer 事件与胶囊同一条面板路径）、Open DSH Terminal、关于、Quit DeepCode——无 Check-for-Updates 占位。托盘全部动作走既有命令调度/控制器。

**唯一命令层。** `desktop-command.ts` 是桌面维护命令的 Desktop Command Broker（绝不替代 agent subprocess service）：exact executable + argv、绝不拼 shell string、绝不 `shell: true`；DSH_HOME/profile 由调用方显式解析；dev/packaged 的 Node/pnpm/DSH 路径解析（`resolveNodeCommand`/`resolvePnpmCommand`/`resolveDshCliCommand`）；stdout/stderr 逐流经共享流式脱敏器；cancel 杀完整进程树；exit code 结果明确；模块级单例保证同一时间只允许一次维护操作（无队列/重试/watchdog/worker）。

**唯一真实终端。** Open DSH Terminal 经 broker 启动 pty host（`terminal-host.cts`，CJS 以便 `ELECTRON_RUN_AS_NODE` 执行）；host 从显式传入的 runtime `node_modules` 路径（打包态 `resources/dsh/node_modules`、dev `apps/desktop/node_modules`——`createRequire` 绝对路径，绝不 `NODE_PATH`）加载 `node-pty`，开 ConPTY 跑所选 shell，注入 DSH_HOME 与前置的私有 shim PATH，字节流双向桥接；stdout 是纯 pty 字节（welcome 行直写这条输出流——绝不写进用户 shell 的 stdin，零转义规则、零终端历史污染），stderr 走 JSON-lines 事件（exit/error）。终端窗口渲染 xterm（vendored 静态 ESM 资产在 `src/terminal/vendor/`，配最小 ambient d.ts；已入库，可经 `scripts/vendor-terminal-assets.mjs` 重新生成）于窄 preload 之后。关窗即 cancel host，退出等待该 cancel 完成。

**唯一打包 Runtime。** 发行构建把仓库 `packageManager` 的 pnpm pin 作为 staging 依赖，使 `resources/dsh/node_modules/pnpm` 出厂可重复的私有 pnpm（锁文件 pin），经 `DeepCode.exe pnpm/dist/pnpm.cjs` 执行。`verify-desktop-dist.ps1` 断言三者（Node、pnpm、DSH CLI）在纯系统目录 PATH 下真实可执行。

**私有终端 shims，运行时生成。** 终端的 PATH shims 在每次打开终端时重新生成到 userData 下 app-owned 目录（`deepcode-bin/`）：`node.cmd`/`pnpm.cmd` 转发到当前 exact executable（打包态 `DeepCode.exe`，dev Node），`dsh.cmd` 转发到做 argv 级 Profile 默认的 CJS wrapper——wrapper 内容由 main（其 fs 带 asar 补丁，锚法与 chrome/terminal 资产相同）读出并写进 `deepcode-bin/` 与三个 .cmd 同目录，shim 永远指向真实文件，纯 Node 执行绝不依赖读 app.asar。shim 目录只 **prepend**（绝不替换——用户 PATH 原样保留）给新开的 terminal process——父环境与任何永久环境变量绝不触碰，不下载任何东西，不猜测系统安装。

**argv 级 Profile 默认。** bare `dsh` 与 plugin 维护命令默认 target active Profile；显式 `--profile X` / `--profile=X` / `web` 子命令 / `plugin --profile X` 永远优先；`-h`/`--help`/`-V`/`--version` 原样透传（注入会把 `dsh -h` 从 launcher help 静默变成 profile app 的 help）。规则在 `terminal-service.ts` 的 `resolveProfileArgv`（结构化 argv 扫描——绝不字符串 replace、绝不 shell parsing），并在 CJS wrapper 里逐字镜像；单测与真实 spawn 测试把两份拷贝锁在一起。终端的 DSH_HOME 永远是 launcher active Home 的真实路径。

**终端宿主选择。** `resolveTerminalShell` 按序探测 exact 路径——Windows Terminal（App Execution Alias `wt.exe`）→ PowerShell（System32）→ cmd（System32）——上一候选不存在才进入下一候选；启动后的真实失败明确报告，绝不无限 fallback。Windows Terminal 以独立窗口启动，exact argv `-d <cwd> <System32 cmd.exe> /k <shimDir>\deepcode-welcome.cmd`（welcome 脚本只含 echo 行、打印后交还交互 shell；承载用 cmd 是因为 /k 是 cmd 的 argv 语义，PowerShell 的 -Command 会违反 no-shell-string 铁律）；内嵌回退在 ConPTY 里运行所选 shell。`resolveTerminalCwd` 优先 active Profile 目录（来自 discovery），不可用时回退 Harness Home 并在 welcome 说明——绝不静默锚到 Electron install dir。welcome 显示 DeepCode/DSH 版本、Active Profile、DSH_HOME、Node/pnpm/dsh 的私有 Runtime 来源、宿主与 cwd。Tray 与 chrome 都调用同一个 `openDshTerminal` 服务。

## Alternatives considered

- **app 级 session-end 事件**：拒绝——Electron 43 类型显示 `query-session-end`/`session-end` 是窗口事件；在主窗口上处理才是受支持面。
- **托盘侧第二份状态存储**：拒绝——托盘模板是既有控制模型的纯函数；任何第二份存储都会像当年第二 Home 的 bug 一样漂移。
- **无 pty 的终端（管道行 IO）**：拒绝——`dsh --profile tui` 需要真实终端；经 runtime 既有 `node-pty` prebuild 走 ConPTY 保持终端真实，pty host 在 `ELECTRON_RUN_AS_NODE`（Node ABI）下运行，避开 Electron ABI 重编译。
- **终端 shell 用 `cmd /c start ...` 或 shell string**：拒绝——broker 的 exact-argv 铁律是绝对的；交互 `cmd` 由 node-pty 以 argv `['/d']` 直接 spawn。
- **从 corepack 缓存复制 pnpm**：拒绝——构建机路径不可重复；经 committed runtime lockfile pin 的 npm 包才是。
- **崩溃后自动重启**：拒绝——崩溃循环会掩盖失败；failed + 手动 Restart Harness 让证据可见、用户掌控。

## Consequences

- DeepCode 成为常驻宿主：close-to-tray 只解释一次、绝不反复惊扰；退出诚实且有序；关机/注销绝不被对话框阻塞。
- DSH 崩溃不再拖垮应用：chrome 与托盘存活，failed 状态归 controller 所有，恢复是显式的一次动作。
- 托盘与 chrome 共享一个控制模型、一条命令路径；终端共享 broker，维护命令具备 exact argv、流式脱敏、明确结果与整树取消。
- 打包应用对终端使用自包含：Node（Electron）、pnpm（私有、锁文件 pin）与 DSH CLI 在纯净 PATH 下全部真实可执行，由打包验收断言；绝不触碰系统 PATH、注册表、PowerShell profile 或 shell 配置。

## Deferred

- UI state schema 因新增 `closeToTrayNoticeAcknowledged` 从 1 升到 2：P1 期的本地偏好会失效一次回退默认（接受——尚无发布用户；pre-release 立场本就允许直接拒绝旧格式）。
- broker 的单槽约束与长驻的内嵌终端会话存在张力：终端 pty host 运行期间，未来的 plugin 操作会撞上 `DesktopCommandBusyError`。P3 开工前必须把"终端会话"与"维护操作"拆成两个槽位（或补排队语义），再建 Plugin Manager。
