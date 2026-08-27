# DeepSeekGUI

[English](README.md) | 中文

**DeepSeekGUI 是 DeepSeek Harness 的非官方社区桌面客户端，与 DeepSeek 无隶属关系，也未获其背书。** Harness 运行时与官方 Web UI 是 DeepSeek 的作品；DeepSeekGUI 是 See-Sol-Lab 在其之上构建的产品层。

DeepSeekGUI Desktop 是 DeepSeekGUI 产品的 Windows 宿主与发行载体：Desktop Chrome 控制层、原生 Harness 控制面（Managed/Existing Home、profile 发现与切换、last-known-good 恢复）、Workbench 地基，以及内嵌官方 DeepSeek Harness Web UI 的 Compatibility View。当前内容区仍以 Compatibility View 为主——与 `pnpm dsh web` 相同的服务（按 DeepSeekGUI 品牌重新构建，并加了若干宿主钩子）——但官方 Web UI 是现阶段的兼容内容面与回归基线，不是产品上限。Harness 始终是唯一运行时；DeepSeekGUI 不引入第二套会话、凭据或配置存储。

## 首次使用（非程序员最短路径）

1. 运行安装程序（`DeepSeekGUI-Setup-…exe`），不需要管理员权限。这是一键安装：没有向导，文件就位后 DeepSeekGUI 会自己启动。
2. 之后从桌面或开始菜单快捷方式启动 **DeepSeekGUI**。
3. 左下角进入**设置**，打开 **Models** 页面。
4. 填入 DeepSeek API key。密钥由 DSH 官方凭据机制保存在应用自己的数据目录中——绝不会进入安装包、日志或命令行。
5. 返回首页，选择一个工作区文件夹。
6. 新建会话，开始使用。

打包版应用的数据位于 `%APPDATA%\DeepSeekGUI\dsh`（凭据、设置、会话、profiles），从不读取全局 `~/.dsh`。卸载时会**问你**要不要连 `%APPDATA%\DeepSeekGUI` 一起删；选「否」则凭据、设置与会话都保留，以后重装可以接着用。静默卸载（`/S`，升级替换旧版本走的也是这条）从不询问，一律保留数据。Chromium 标准开关 `--user-data-dir=<路径>` 可整体重定位 Electron userData（launcher state、单实例锁、Managed Home、诊断日志），用于便携部署与测试隔离；Windows 上 userData 经 Known Folder API 解析，从不跟随 `APPDATA` 环境变量。

## 从源码运行

在仓库检出目录（需要 Node.js 与 pnpm）：

```sh
pnpm install
pnpm run build        # builds the Web UI dist the shell serves
pnpm run dev:desktop  # opens the DeepSeekGUI window
```

`dev:desktop` 编译 `apps/desktop` 并启动 Electron。主进程在本机固定端口 `3080` 启动 DSH Web 服务，等待服务响应后才创建窗口。关闭窗口只是隐藏窗口，Harness 继续在系统托盘运行；Quit DeepSeekGUI（托盘或菜单）才真正停止 DSH 服务并退出——真正退出后不残留后台 Node 进程或占用端口。

## 构建可移植发行目录与安装程序（Windows）

一条命令同时产出自包含、可双击的 Windows 目录与按用户安装的 NSIS 安装包：

```sh
pnpm run build:desktop-dist   # rebuilds lib/web/desktop from current source, then packs, installs, assembles, sanitizes, packages
```

该命令总是先从当前检出的源码重建全部输入（`build:lib:host`、`build:web`、`build:desktop`），发行物绝不可能打进过期产物；入库的应用图标只在缺失时重新生成。

产物为 `dist/desktop/win-unpacked/DeepSeekGUI.exe` 与 `dist/desktop/DeepSeekGUI-Setup-<version>.exe`。目录内嵌完整 DSH 运行时（`resources/dsh/node_modules`）、Web UI dist 与壳；不需要 Node.js、pnpm 或源码检出。exe 自身充当 Node 运行时（`ELECTRON_RUN_AS_NODE`），不依赖任何 PATH 条目。安装程序是一键式的（没有向导，装完自动启动），仅按当前用户安装到 `%LOCALAPPDATA%\Programs\DeepSeekGUI`，卸载项写在 HKCU，无需管理员权限，带开始菜单与桌面快捷方式。构建在打包前先净化载荷，若产物泄漏 `.git`、`.env`、会话日志、用户路径或 API key 会大声失败。版本门禁让不一致的交付物不可能产生：声明的 dsh tarball 版本必须等于实际装进 runtime 的版本、安装包文件名必须携带 DeepSeekGUI app version，构建还会写入 `resources/dsh/source-commit.txt`（git HEAD），每个发行物都可溯源。

## 工作机制

| 关注点 | 机制 |
|---|---|
| DSH 服务 | 启动 `@deepseek-ai/dsh` 入口——开发态在仓库根目录 `node --import tsx/esm apps/cli/src/bin.ts`；打包态由 exe 以 `ELECTRON_RUN_AS_NODE` 运行 `resources/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`——始终带 `--host 127.0.0.1 --port 3080`。`--profile` 与 `DSH_HOME` 完全来自 launcher state 的 active selection，经 `src/dsh-service.ts` 的 `resolveDshLaunch` 组装。 |
| Launcher state | `%APPDATA%\DeepSeekGUI\launcher-state.json`（Electron userData 下，绝不写入 `DSH_HOME`）记录当前 harness 选择：home 引用——`managed` 在运行时解析为 `%APPDATA%\DeepSeekGUI\dsh`；`existing` 为显式绝对路径、原样使用（保留空格与 Unicode，绝不创建/迁移/合并）——加上 profile 名称（默认 `web`；满足官方 profile 命名规则即可——非空、不含 `/` 或 `\`、不得为 `.`/`..`/`node_modules`——是否 Web-capable 由后续包判断）。记录为 `schemaVersion: 1`，含 `active`、`pending`、`lastKnownGood` 与 `lastBootFailure`——最近一次切换/重启失败的限长脱敏记录；普通启动成功不清除，只有下一次完整成功的切换或重启才清除。文件缺失即默认（managed + web）。文件损坏不再只有退出，而是应用内救援：恢复默认设置（先把坏文件原样备份为 `.invalid-<时间戳>`，再原子写入默认——绝不触碰用户的 Home、会话、凭据、Profiles 与插件）、打开配置所在文件夹、或退出。写入为同目录临时文件 + rename 原子替换。 |
| UI state | `%APPDATA%\DeepSeekGUI\desktop-ui-state.json`（Electron userData 下，与 launcher state 分离）只保存五项偏好事实：`windowBounds`、`maximized`、`themePreference`（`system`/`light`/`dark`，默认 `system`）、已确认恢复提示的 hash、专家详情展开状态（P8-D39 后已无 UI 消费；保留在 schema 里只为让既有 state 文件继续可解析）。严格解析器拒绝一切未知字段——session、model、credential、Profile、selection、plugin、Memory、Compaction、Hook 事实根本存不进去——写入原子替换。读取永不抛出：损坏的 UI state 回退安全默认值并记录原因，UI 偏好永远挡不住 launcher 与 Harness 运行时。 |
| 数据目录 | 开发态与打包版同一规则：DSH_HOME 只由 active selection 决定，`DSH_HOME` 环境变量不再覆盖。 |
| 端口冲突 | 启动前先做 TCP 探测；端口被占用时弹出可理解的错误对话框并以退出码 1 结束——不静默换端口、不重试。 |
| 就绪等待 | 轮询 `http://127.0.0.1:3080/` 直到收到 HTTP 响应（60 秒上限），然后开窗。 |
| 窗口 | `BrowserWindow` 使用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；渲染进程没有 Node、Shell 或文件访问权限。窗口内导航限制在本机 DSH 源内并拒绝新窗口；外部 `http`/`https` 链接交系统默认浏览器打开，远程页面绝不在窗口内加载。窗口标题固定为 `DeepSeekGUI`。位置、尺寸（最小 800×520）与最大化状态在事件边界保存（debounce，零轮询），恢复时 clamp 到当前显示器可见工作区——显示器拔除、DPI 或分辨率变化后窗口绝不会跑出屏幕；minimized 绝不覆盖已保存的 bounds。窗口只有唯一的普通主题背景路径——材质表面（Electron `backgroundMaterial`/透明）会让 Chromium 放弃 ClearType 子像素抗锯齿、把官方页面文字渲染糊掉，故保持移除，直到在高分屏上重新取证。 |
| 单实例 | 第二次启动立即退出，并把既有窗口带到前台。 |
| 诊断 | 打包版把 DSH 服务输出写入 `%APPDATA%\DeepSeekGUI\dsh-service.log`，经有限轮转策略（current + 至多 4 份历史 = 共 5 份，另有总大小 budget，最老先删——crash 证据在下一次普通启动时 shift 进历史，绝不会被立刻顶掉）。凭据形态文本——API key、GitHub/Slack token、AWS access-key id、Bearer token——由同一套共享规则脱敏，即使凭据被 stream chunk 边界拆开也流式安全；错误对话框指向该日志。开发态与 smoke 继承控制台。 |
| 关闭 | Quit DeepSeekGUI（托盘或 chrome 菜单）是唯一真正退出：诚实确认后，`controller.stop()` 终止整棵 DSH 进程树并等待其退出，销毁托盘与视图，应用退出。窗口 X 只是隐藏窗口（常驻托盘模式；首次用一次性气泡说明）。OS 关机/注销走无交互的 orderly cleanup。DSH 意外崩溃时 chrome 与托盘保持存活：controller 成为唯一 failed 状态来源（阶段 `runtime`），UI 显示脱敏诊断，Restart Harness 用 active 重新启动——不自动重启、不循环回退。 |
| 托盘 | 常驻 `Tray`，菜单与 chrome 从同一控制模型重建（同一份 selection、同一份运行状态）：打开 DeepSeekGUI、只读当前 Profile、实时 Harness 状态、Profiles 快速切换子菜单（radio，仅可启动项）、重启 Harness、打开 Harness 面板、打开 DSH Terminal、检查更新（有新版本时菜单项显示版本号）、关于、退出 DeepSeekGUI。 |
| DSH Terminal | 终端窗口渲染真实 ConPTY（pty host = `ELECTRON_RUN_AS_NODE` + runtime 内 `node-pty`；xterm UI）。宿主按 exact 路径顺序探测——Windows Terminal（`wt.exe`）→ PowerShell 7（`Program Files\PowerShell\7\pwsh.exe` 或 Store 别名，仅用户终端推荐项）→ PowerShell（System32）→ cmd（System32）；Windows Terminal 以独立窗口打开，否则所选 shell 内嵌运行。未安装 PowerShell 7 时 Harness 面板有一行非阻塞推荐（`winget install --id Microsoft.PowerShell --source winget`），绝不弹窗、绝不自动安装；Agent 的 sandboxed PowerShell 走 Harness 的 tool/security 路径，绝不因检测到 pwsh 而绕过沙箱。cwd 优先 active Profile 目录（不可用时回退 Harness Home 并在 welcome 说明）。PATH 前置运行时生成的私有 shims（`userData/deepseekgui-bin/`：`dsh`/`node`/`pnpm` 转发当前 exact executable，shim 目录绝不碰系统 PATH/注册表/shell 配置）；bare `dsh`/plugin 命令经 argv 级 wrapper 默认 target active Profile（`--profile X` 永远优先；`-h`/`--version` 原样透传）。welcome 显示 DeepSeekGUI/DSH 版本、Active Profile、DSH_HOME 与 Node/pnpm/dsh 的私有 Runtime 来源。host 经 Desktop Command Broker 运行——exact executable + argv、绝不拼 shell string、绝不 `shell: true`、输出流式脱敏、cancel 杀完整进程树、同一时间只允许一次维护操作。关闭终端窗口即 cancel host；启动失败明确报告，绝不无限 fallback。 |
| 插件管理 | Harness 面板的二级页面（只属于 Desktop Chrome，绝不注入 Compatibility View），全部写操作走官方 `dsh plugin --profile <target> <pnpm args...>` 路径——不做 Marketplace、推荐、远程目录或"热门插件"。inventory 显示三种绝不混写的事实、各来自唯一来源：Profile Bundles（`dsh profiles --json` 的 `bundles` 层；模板 bundle 与依赖派生 bundle 用 manifest `dependencies` 键交叉区分）、已安装依赖（profile `package.json` 的 `dependencies`，只读文档）、Effective/Loader 事实（官方 `staticStatus`/`evidence`）。package.json 里存在 dependency 不等于插件已加载。每次写操作（add/remove/update/install）前弹出目标透明度确认（Home kind、完整路径、Profile、操作、spec；Existing Home 明确显示「这次操作会修改你选择的现有 Harness Profile。」），经 Desktop Command Broker 的 maintenance 槽执行（与常驻终端的槽位相互独立——插件操作绝不阻塞终端，反之亦然），输出流式脱敏、可 Cancel（杀完整进程树），exit 0 才做 post-check（从磁盘重读 discovery + manifest 验证预期变化），随后刷新 inventory 并给出 Restart Now / Later 提示（「插件变更已完成，需要重启 Harness 才会进入新的 Loader composition。」）——绝不自动重启。发现、浏览、刷新零写入；只有用户明确确认的管理动作会写目标 Profile。本地路径 spec 锚定到用户选择的目录并在操作前校验存在性（pnpm 对不存在的目录会静默写入 link 依赖且 exit 0，desktop 在边界处先拒绝）；每个 spec 都是单个 argv 元素；用户输入与锚定后的最终值都会拒绝空白、cmd 元字符与控制字符——官方 CLI 在 Windows 上经 shell 转发 pnpm，所以 desktop 边界才是"spec 或锚定目录名不会变成一条命令"的保证。面板内的「如何安装插件」帮助块如实说明 DeepSeekGUI 不经营插件市场、兼容插件从哪里找。每次经确认的 GUI 写操作进入受保护事务：执行前 DeepSeekGUI 对三个白名单文件（`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`；不存在就记录 absent，绝不伪造空文件）做 byte-identical 快照 + hash，恢复日志只存放在自己的 userData 里——写路径本身仍只走官方 CLI。post-check 成功后日志进入 pending-verification，只有下一代 Harness generation 真正健康（HTTP 就绪 + 官方 UI 挂载 + DeepSeekGUI client 主题插件 settle——绝不是"端口有响应"）才算验证完成；同一 Home/Profile 同时最多一个 pending 未验证事务；Restart Later 保留日志、下次启动验证。下一代启动失败时先核对 post hash：任一白名单文件在事务后被外部修改（drift）即停止恢复，只给人工入口（打开 Profile 文件夹 / 打开 DSH 终端 / 放弃——绝不覆盖）；无 drift 时 Managed Home 从快照恢复三个白名单文件并最多自动重启一次（第二次仍失败即停止自动动作），Existing Home 未经明确确认（列出将恢复的具体文件）绝不恢复。`node_modules` 从不备份、从不恢复；没有事务数据库——一个窄 journal + 三个文件快照，仅此而已。 |
| 更新服务 | 只比较 DeepSeekGUI app version——绝不用 embedded DSH version 驱动更新决策。provider 读取 HTTPS feed manifest（严格解析：stable `latestVersion`、release notes、资产带 HTTPS URL + SHA-256 + size + 安全文件名）；feed 配置在 `userData/deepseekgui-update-feed.json`，repo 私有期间没有公开通道——Manual Check 明确显示「当前未配置公开更新通道」，background check 安静结束，绝不请求用户 personal token、绝不打包仓库凭据。background check（延迟调度、不阻塞启动）对网络错误静默，只对 strictly newer stable 提示（每个版本一次托盘气泡）。Manual Check 对已是最新/未配置/失败都给出明确结果；下载前必须明确确认，Cancel 立即停止，partial 清理，size 上限与 SHA-256 digest 验证通过前绝不执行，只抓取配置 provider 返回的 HTTPS URL。验证后弹「退出 DeepSeekGUI 并开始安装更新？」——确认则 orderly 停止 Harness、关闭视图/托盘、spawn 已验证的 NSIS installer（exact path、detached）并退出；spawn 失败保持当前应用可用、绝不删除当前安装。已验证 installer 采用 single-slot 保留策略：更新缓存目录内最多一份产物（新下载先清空目录），落盘记录的已验证安装包在重启后恢复，并在交给安装程序前用记录的 digest 重新校验一次——不符就拒绝执行，绝不运行来路不明的文件。SmartScreen 限制在 UI 与文档中明确（暂无代码签名证书；本阶段不做假签名验证）。 |
| 诊断中心 | 官方设置页内的 DeepSeekGUI 分区（P8-D39），只显示 allowlist 事实——DeepSeekGUI version、embedded DSH version/source、Electron/平台/架构、active Home kind（绝不显示路径）、active Profile、Harness 状态、诊断日志位置、更新通道——加三个操作：打开日志文件夹、复制构建信息（main 进程剪贴板）、导出诊断包。bundle 是 `userData/diagnostics/` 下的本地目录（绝不上传）：`bundle-manifest.json` 逐文件列出来源与大小、脱敏日志副本（current + 全部轮转历史）、上次退出事实（启动时写 `active-run.json` marker、正常退出时删除——残留 marker 就是"上次未正常退出"的最小证据，绝不自动断言 crash）、本地 Crashpad dump（总量 50 MB 有界、最新的优先、被跳过的如实记入 manifest，绝不伪造"全部导出成功"）、build-info 文本；credential、`.env`、session 正文结构性排除（文件名 allowlist、无 session log），用户路径导出前归一化为 `<USER_HOME>`。崩溃转储可能含本地路径与内存片段，导出对话框会提示公开发布前先检查内容。导出失败绝不删除原日志或用户数据。GUI 完全起不来时，`DeepSeekGUI.exe --export-diagnostics` 以 headless 模式运行：不启动 Harness、不加载 Profile/第三方插件、不建窗口/托盘、绝不监听 3080——只组装并导出同一份本地 bundle，路径打到 stdout 后退出（60 秒上限，失败非零退出码）。 |
| 权限 | Harness 是唯一权限事实源；DeepSeekGUI 绝不保存自己的权限状态。Harness 面板从官方 settings service 实时读取并显示真实权限模式——`Permissions: Sandbox`（推荐默认，workspace-write 沙箱 + ask 审批）、`Permissions: Full Access`（danger-full-access）、`Read-only` 或 `Custom`。全新 Managed Home 默认即为推荐的 Sandbox 预设；若官方服务还没有明确的默认值，DeepSeekGUI 会在第一个 Agent session 之前经官方 settings API 写入推荐预设——Existing Home 只显示、绝不静默修改。切到 Full Access 必须显式风险确认（「完全访问权限会让 Agent 工具获得当前 Windows 账户允许的更大访问范围。当前工作区之外的文件也可能被读取、修改或删除。只有明确理解风险时才使用。」）；Existing Home 切回 Sandbox 同样先确认（「这会修改你选择的现有 Harness 设置。」）。权限服务读不到时 UI fail closed：显示「权限控制不可用」，绝不假装 Sandbox、绝不静默回退 Full Access。Agent 审批保持 Harness 原生行为——DeepSeekGUI 绝不自动批准、绝不吞掉批准/拒绝界面、不维护自己的信任缓存。 |
| 日志保留 | 服务日志在打开时经有限策略轮转（current + 至多 4 份历史 = 5 份，另有总大小 budget，最老先删）取代旧的 current + `.old` 两份——crash 证据在下一次普通启动时 shift 进历史，绝不立刻被顶掉，日志也绝不会无限增长。每份文件都经同一套流式凭据脱敏写入。无日志数据库、无后台清理服务。 |
| 发行物完整性 | 发行构建写 `SHA256SUMS.txt` 发布清单（installer + 解包 exe），`verify-desktop-dist.ps1` 另加门禁：app.asar 存在（Desktop Chrome 资产出厂）、四份 license notices（PolyForm / DEEPSEEKGUI-LICENSE / MIT / THIRD_PARTY_NOTICES）、载荷内无 session log（`.jsonl`）、清单里每个 digest 重算并逐一比对。 |
| Desktop Chrome | DeepSeekGUI 拥有 47px 顶栏（隐藏系统标题栏，`titleBarOverlay` 保留 Windows 原生窗口按钮）：常驻可见的汉堡菜单、Harness 状态胶囊（P8-D19 起为纯指示灯，不可点击）——controller 的七相状态映射为颜色（灰=未运行/停止中，蓝=启动/切换中，黄=恢复中/已恢复，绿=运行中，红=启动失败），切换期间实时变化。P8-D39 起，Harness 控制面（Home 类型与路径、当前 profile、逐 profile 切换、刷新、选择已有 Home、使用托管 Home、重启、恢复详情）、插件管理与 BUG 诊断反馈全部作为 DeepSeekGUI 分区住进官方设置页，经本机回环控制桥回到同一个封闭命令联合——汉堡菜单只留只读状态区、DSH 终端、检查更新与「关于 DeepSeekGUI」（对话框，只由受控事实组装：app version、内嵌 DSH version/source、Electron、平台/架构、Active Home kind、Active Profile、license summary、项目仓库——API key、credential、会话正文与环境变量在结构上不可能出现）。真实恢复发生后（配置启动失败且 controller 已回退 last-known-good），顶栏出现一次非阻断横幅「刚才的配置没有启动成功，DeepSeekGUI 已恢复到 <profile>。」，带「查看详情」/「知道了」——每条失败事实只提示一次，确认写进 UI state，不清持久化失败、不伪造恢复。Chrome 是受信任的本地 renderer，经窄 preload API 与 main 侧验证的封闭命令联合工作。中文 locale 显示中文文案，其余回退英文。 |
| 交付身份 | About 对话框与所有工件携带四个来自唯一来源的事实：DeepSeekGUI app version（`apps/desktop/package.json`，首个公开版本为 `1.0.0`，独立于 DSH 仓库版本）、从实际打包 Runtime 读取的 embedded DSH version、embedded DSH source/commit 标识，以及 Electron version + platform/arch——由 `src/version-info.ts` 组装，每个事实只有一个权威来源，不一致时构建门禁明确失败。 |

## Smoke 模式

`DSH_DESKTOP_SMOKE=1 pnpm run dev:desktop` 走相同的启动路径但不弹 GUI 对话框：页面加载完成后打印 `[deepseekgui] window loaded`，关闭窗口并退出——适合脚本化验证，无需真实模型对话。

## 上游兼容套件

`pnpm run test:desktop-parity` 通过 playwright-core 的 Electron 驱动，在完全隔离的环境中直接驱动打包后的 `dist/desktop/win-unpacked/DeepSeekGUI.exe`（Electron userData 经 `--user-data-dir` 重定位到测试临时根；`APPDATA`/`LOCALAPPDATA`/`DSH_HOME` 钉扎其中作纵深防御；凭据形态环境变量全部剔除；不调用模型）。打包 exe 缺失时运行明确失败。该套件的职责是保证 DeepSeekGUI 没有破坏上游 Web/Harness 能力——4 个生命周期行已验证、25 个功能行作为兼容 backlog 跟踪。计划中的工作一律不记为已验证。

## 打包验收（B1 Case A–F）

`pnpm run test:desktop-parity` 同时驱动 B1 打包验收：Case A 全新 Managed/web；Case B 含两个兼容 profile 的 Existing Home，经 Desktop Chrome 状态胶囊与 Harness 面板（production control entry 上的真实 DOM 点击，不是测试 helper）切换与重启；Case C profile-local 第三方 Cordis 插件在打包 exe 内真实执行；Case D apply-throw 切换回退 last-known-good；Case E 关闭重开后 selection 保持；Case F profile 定义、第三方包与 sentinel 绝不复制、迁移或改写，discovery-only 运行可证明零写入，Existing sentinel 绝不进入 Managed Home。每个 case 都在含空格与 Unicode 的隔离临时根内运行、剔除凭据形态环境变量、不调用模型，并验证打包 exe 不需要外部 Node、pnpm 或 PATH 条目。

## 安装未签名的安装包

第一版不做代码签名——受众是开发者，同类客户端同样不签名，现阶段的钱应该花在产品本身——，所以 Windows SmartScreen 会拦一下并提示"未知发布者"。这不是安全问题的信号，只是说明这个安装包没买证书——但也正因为没有签名可依赖，请在安装前自己核对哈希。

**继续安装**：在 SmartScreen 蓝色窗口点「更多信息」→「仍要运行」。

**核对哈希**（没有签名时的信任替代品，随发行物一起发布的 `SHA256SUMS.txt` 里有期望值）：

```powershell
Get-FileHash .\DeepSeekGUI-Setup-<version>.exe -Algorithm SHA256
```

输出的 `Hash` 与 `SHA256SUMS.txt` 中对应行**逐字一致**才安装；对不上就不要运行，请到仓库 Issue 反馈。

## 已知限制

- 没有代码签名（Windows SmartScreen 会提示"未知发布者"，继续安装与核对哈希的步骤见上一节）、开机启动或账号系统；更新服务已就位但出厂未配置——repo 私有期间没有公开更新通道，Check for Updates 显示「当前未配置公开更新通道」，直到 HTTPS feed manifest 发布并配置（`userData/deepseekgui-update-feed.json`）。
- 仅在 Windows x64 上验证；macOS 与 Linux 未实测。
- 从任务管理器强杀 Electron 可能遗留 DSH 子进程；正常关窗与退出路径总会清理。
- 发行目录体积较大（解包约 540MB、安装包约 145MB）：Electron 加上完整的 DSH web profile 运行闭包。
- 插件管理 v1 边界：目标仅限 active Home 下已发现的 profile（不自动 init 新 profile、不跨 Home 写、无 Marketplace）；install/repair 就是官方 `pnpm install` 转发（pnpm 没有独立的 `repair`）；含空白字符的 spec 一律拒绝（官方 CLI 在 Windows 上经 shell 转发 pnpm，含空格的路径参数会被拆词——desktop 在边界拒绝而不是绕开官方 CLI），DSH_HOME 路径含空格时本地路径 add 有同样的上游约束；本地路径含空格的插件需先移动到无空格路径。同一上游转发还导致插入符范围（`^1.0.0`）与含 `|`、`>` 或空格的复合 semver 范围不受支持（cmd 会吞掉插入符并把范围悄悄窄化），本地插件路径（含在选择框里挑的锚定目录）必须不含空白与 cmd 元字符。

## 常驻宿主（托盘）与 DSH Terminal

DeepSeekGUI 常驻运行：点窗口 X 只是隐藏窗口，Harness 继续在系统托盘运行（首次关闭时用一次性非阻断气泡说明；确认位存进 UI state）。托盘菜单与 chrome 从同一控制模型重建——打开 DeepSeekGUI、只读当前 Profile、实时 Harness 状态、Profiles 快速切换子菜单、Restart Harness、Open Harness Panel、Open DSH Terminal、关于、Quit DeepSeekGUI（无 Check-for-Updates 占位）。Quit 弹出诚实提示「退出 DeepSeekGUI 会停止 Harness，并中断当前正在执行的任务（如果有）。」（绝不虚假声称检测到任务），随后停止完整 DSH 进程树、销毁托盘与视图并退出。再次运行快捷方式会显示并聚焦已有窗口——绝不启动第二个 Harness。OS 关机/注销走无交互 orderly cleanup（无阻塞对话框）。DSH 子进程意外退出时，chrome 与托盘保持存活，controller 成为唯一 failed 状态来源（阶段 `runtime`），UI 显示脱敏诊断，Restart Harness 以 active 重启——无自动重启循环、无回退循环。

Open DSH Terminal 经同一服务（托盘与 chrome 共用）打开按 exact 路径探测的终端——Windows Terminal → PowerShell 7（仅用户终端推荐项）→ PowerShell → cmd。终端的 DSH_HOME 是 launcher active Home 的真实路径，cwd 优先 active Profile 目录（Harness Home 回退在 welcome 里说明），bare `dsh`/plugin 命令默认 target active Profile（`--profile X` 永远优先）。终端 PATH 前置运行时生成的私有 shims（`userData/deepseekgui-bin/`），转发到当前 exact executable；shim 目录绝不触碰父环境或任何永久环境变量，不下载任何东西，不猜测系统安装。welcome 显示 DeepSeekGUI/DSH 版本、Active Profile、DSH_HOME 与 Node/pnpm/dsh 的私有 Runtime 来源。发行物 pin 私有 pnpm Runtime（`resources/dsh/node_modules/pnpm`，由 `runtime.package-lock.json` 锁定）并经 DeepSeekGUI.exe 自身执行——绝不读取系统 Node/pnpm、不依赖 global PATH、不修改注册表/PowerShell profile/shell config；打包验收断言 Node、pnpm、DSH CLI 三者真实可执行。

## 许可证

本目录中的 DeepSeekGUI 原创桌面/产品层由 See-Sol-Lab 采用 [PolyForm Perimeter License 1.0.1](LICENSE) 授权。

个人、教育、研究、兴趣、公司内部使用及其他许可范围内的用途都可以。**未经 See-Sol-Lab 另行书面授权，不得向他人提供与 DeepSeekGUI 竞争、可替代其功能或价值的产品。**

随应用打包或引用的 DeepSeek Harness 运行时继续遵循 DeepSeek 的上游 [MIT License](../../LICENSE)，第三方组件继续遵循各自许可证。具体适用范围见仓库级 [DeepSeekGUI 许可说明](../../DEEPSEEKGUI-LICENSE.md)。
