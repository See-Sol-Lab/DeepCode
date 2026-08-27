# Agent Note: DeepSeekGUI 桌面 UI state、窗口几何、主题与 launcher 救援

Status: implemented

[English](2026-08-16-deepseekgui-b2-p1-ui-state-and-daily-ux.md) | 中文

## Problem

桌面此前没有任何持久化 UI 偏好：窗口几何固定 1280×800 且不记最大化，Desktop Chrome 只有深色且不跟随系统，profile 条目满口工程师语言（`Try/Unverified`、`boot-failing`、`headless`），`pending` 摆在默认 Harness 面板里，从失败中恢复的启动毫无提示，损坏的 `launcher-state.json` 只能退出。而 UI 偏好存储有一条铁律：绝不能成为第二个 launcher，也绝不能成为启动阻断——session、model、credential、Profile、active selection、plugin、Memory、Compaction、Hook 事实都不属于它。

## Decision

`apps/desktop/src/ui-state.ts` 拥有 Electron userData 下的 `desktop-ui-state.json`（schema 版本 1），严格白名单恰好五个字段：`windowBounds`、`maximized`、`themePreference`（`system`/`light`/`dark`，默认 `system`）、`acknowledgedRecoveryHash`、`expertDetailsExpanded`（本阶段唯一真正使用的面板偏好）。解析器拒绝任何位置的未知字段——夹带 selection 或 credential 事实的文件整体失效——写入原子替换（临时文件 + rename）。store 的 `read()` 永不抛出：文件缺失返回默认且不创建文件，文件损坏返回默认 + 降级原因，坏的 UI 偏好永远挡不住 launcher/Harness 启动。恢复提示确认是对"失败阶段 + 脱敏消息 + 失败目标 + 恢复目标"的 SHA-256 标识：只活在 UI state 里，绝不清理 `lastBootFailure`，绝不伪造 recovery。

窗口几何从 UI state 保存与恢复。恢复时把已保存 bounds clamp 到当前显示器可见工作区（`apps/desktop/src/window-state.ts` 的 `clampBoundsToWorkArea`，纯函数、有单测）：显示器拔除、DPI 或分辨率变化后窗口绝不可能跑出屏幕，尺寸夹在工作区内、最小 800×520。保存只发生在事件边界——resize/move debounce 500ms、maximize/unmaximize 即时、close 最终——零轮询；minimized 绝不覆盖已保存的 normal bounds（`getNormalBounds`），`maximized` 是独立字段。dev 与打包态共用同一 userData 路径，含空格/Unicode 目录。

主题是默认 `system` 的三态偏好，经 `effectiveTheme` 对照 `nativeTheme.shouldUseDarkColors` 解析。chrome renderer 只给自己文档挂 `data-theme`；Compatibility View 不被注入任何主题逻辑——官方页面原封不动。窗口背景与 titleBarOverlay 颜色跟随生效主题，chrome 与官方 UI 的深色表面不产生刺眼割裂；`nativeTheme.shouldUseHighContrastColors` 的 `highContrast` 标志保持表面实色、基本可读。Mica 只在官方 `backgroundMaterial: 'mica'` API 且 `micaAvailable`（win32 + Windows 11 22H2、build ≥ 22621）成立时启用——不用任何私有 Chromium flag——否则走唯一普通背景路径，不堆叠材料 fallback 链。

文案两套字典全面人话化：candidate 读"尚未验证，可以尝试启动"/"Unverified — you can still try to launch"，boot-failing 读"上次启动失败"/"last launch failed"且阶段不再出现在默认条目里，headless 与 malformed 得到白话解释，`pending` 从默认信息行移入新的可折叠"专家详情"区（其展开状态就是持久化的面板偏好）。原始阶段、目标 selection、脱敏消息与恢复目标全部保留——在专家详情与既有恢复详情块里。

恢复通知对每条失败事实只出现一次：当 controller 状态证明已恢复（会话内回退的 `recovered`，或重启后 `active` 仍等于 `lastKnownGood` 且 `lastBootFailure` 存在），顶栏出现非阻断横幅"刚才的配置没有启动成功，DeepSeekGUI 已恢复到 <profile>。"，带"查看详情"与"知道了"。确认把 hash 写入 UI state，同一条提示不再重复；既不清 launcher 失败，也不伪造恢复。通知在命令与启动完成之后计算（不在 controller 的状态回调里）——切换协议在状态转移之后才持久化晋升结果。

损坏的 `launcher-state.json` 不再只有退出。救援对话框提供：恢复默认（Managed/web）、打开配置所在文件夹、退出。恢复默认先用 `backupInvalidLauncherState` 把坏文件原样复制为 `.invalid-<timestamp>`，之后才原子写默认状态；备份失败大声报错并保持原文件不动，且绝不删除或改写任何 DSH_HOME、Existing Home、session、credential、Profile 或 plugin 内容。smoke 模式跳过对话框并大声失败。

## Alternatives considered

- **launcher 与 UI 共用一份状态文件**：拒绝——launcher state 是启动阻断，损坏必须大声失败；UI state 绝不能挡启动。两个文件让两套失败策略分离且一目了然。
- **宽容的 UI state 解析（保留已知字段、丢弃未知字段）**：拒绝——部分采纳会在下次写入时静默改写用户文件；夹带的 selection/credential 字段必须让整份记录失效，而不是被静默丢弃。
- **轮询保存窗口几何**：拒绝——定时器是电池与脏检查的坏味道；debounce 的事件边界保存 + 关窗最终保存覆盖一切变化，无需轮询。
- **把主题注入 Compatibility View**：拒绝——官方 Web UI 是不动的回归基线；chrome 只主题化自己，窗口背景弥合接缝。
- **Mica 走 fallback 链（mica → acrylic → 普通）**：拒绝——单一实现路径；官方 `backgroundMaterial` + OS build 判定，否则普通背景。
- **确认通知时清理 `lastBootFailure`**：拒绝——持久化失败是切换的证据，只有下一次完整成功的 switch/restart 才清；通知自身的去重属于 UI state。
- **救援去修复或改写用户 profile**：拒绝——救援只恢复 launcher 的默认选择；用户 profile 定义、Home、会话与凭据一概不碰。

## Consequences

- UI 偏好（几何、最大化、主题、专家详情展开、已确认提示）跨重启保留，同时永远没有能力阻断启动：损坏的 UI state 回退默认并记录原因。
- 窗口恢复在显示器拔除、DPI、分辨率变化下安全；dev、打包态与空格/Unicode userData 路径共用同一套有测试的纯函数 clamp。
- chrome 默认跟随系统主题，可显式选浅色/深色，high contrast 下保持可读，且绝不触碰官方 Web UI；Mica 只在官方 API 与系统支持时出厂。
- 默认文案面向普通用户，专家事实保持可达：pending 与 boot 失败阶段藏在专家详情后，恢复横幅把过去的静默回退变成一次温柔的、仅此一次的提示。
- 损坏的 launcher state 现在可在应用内救援：原样备份、原子写默认、零接触用户数据；launcher schema 的严格性不变。
