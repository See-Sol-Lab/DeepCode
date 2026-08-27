# Agent Note: DeepSeekGUI 桌面交付身份、CI lane 与 Windows parity 矩阵

Status: implemented

[English](2026-08-16-deepseekgui-b2-p1-delivery-identity.md) | 中文

## Problem

DeepSeekGUI 桌面包一直沿用根仓库的 DSH 版本出货：`apps/desktop/package.json` 写的是 `0.1.0-rc.5`，于是安装包文件名（`DeepSeekGUI-Setup-0.1.0-rc.5.exe`）与 exe 元数据都把上游 Harness 版本当成了 DeepSeekGUI 产品版本，且没有任何公开版本契约。embedded DSH runtime 的版本虽然能从实际打包 Runtime 读出，但没有门禁断言它与声明的 tarball 版本一致，B1 第 6 扇窗的"npm 缓存复用旧 tarball"失效模式仍可能静默出货。打包产物不带 source/commit 标识，发行物无法溯源到具体 checkout。桌面 PR 没有 DeepSeekGUI 专属 CI lane——上游覆盖躺在全仓库矩阵里——也没有针对官方桌面发行版的持续比较矩阵。

## Decision

DeepSeekGUI Desktop 现在拥有独立交付身份。`apps/desktop/package.json` 为 `0.1.0-alpha.1`——第一个 DeepSeekGUI app 版本，独立于 DSH 仓库版本演进——公开版本契约记录四个事实，各有一个唯一权威来源。DeepSeekGUI app version（desktop manifest 唯一手写，打包态经 exe 元数据读回）；embedded DSH version（读实际打包 Runtime 的 `resources/dsh/node_modules/@deepseek-ai/dsh/package.json`；开发态读源码入口 `apps/cli/package.json`——绝不维护第二份手写常量）；embedded DSH source/commit 标识（git HEAD + `+dirty`，由发行构建写入 `resources/dsh/source-commit.txt`；开发态实时 git、非 checkout 环境回退 null）；Electron version + platform/arch（运行时 process 事实）。`apps/desktop/src/version-info.ts` 以纯 Node 模块组装四元组，读取失败抛 `VersionInfoError`。

About 面首次出现：`app.setAboutPanelOptions` 以 app version 为主字段、其余事实为一行详情，由新增的 `show-about` 命令打开——该命令加入封闭 `DesktopControlCommand` 联合，经既有 control dispatcher 从汉堡菜单入口（两套 chrome 字典的 `menu.about`）路由。启动时组装一次版本事实；读取失败只记日志并把 About 降级为 `unknown`，绝不阻断启动——因为构建门禁保证出厂产物不可能缺这些事实。

四道构建门禁让不一致 fail loud。`scripts/build-desktop-dist.ts` 比对声明的 dsh tarball manifest 版本与实际安装进 runtime 树的版本，不一致即中止（缓存旧 tarball 再不能出货）；拒绝任何文件名不含 DeepSeekGUI app version 的安装包；写入 `resources/dsh/source-commit.txt`，git HEAD 不可用即失败。`scripts/verify-desktop-dist.ps1` 断言打包 exe 的 `FileVersion` 等于 desktop manifest 版本、source/commit 文件存在且非空、embedded DSH version 能从打包 Runtime 读回。

DeepSeekGUI 专属 CI lane 位于 `.github/workflows/deepseekgui-desktop.yml`。PR 跑聚焦 Linux job（frozen install、`vitest run apps/desktop/tests`、`pnpm run build:desktop`、对 `apps/desktop` 与 `scripts/build-desktop-dist.ts` 的 oxlint、translation-pairing/agent-note-format/markdown-wrap 三个门禁、`git diff --check`）。main push 与手动 dispatch 跑与上游 CI 同一 runner 池的 Windows native job：从当前源码 `build:desktop-dist`、`test:desktop-parity`（含打包验收 Case A–F）、`verify-desktop-dist.ps1`、验收报告，并上传安装包、消毒后的 `win-unpacked` 目录与报告。两个 job 都有真实触发条件，workflow 不可能在跳过全部 DeepSeekGUI job 时变绿；远端触发只在授权 push 后执行。


## Alternatives considered

- **继续把根仓库版本当产品版本**：拒绝——DSH 仓库版本是上游事实；DeepSeekGUI 必须从 `0.1.0-alpha.1` 独立演进，且 update 阶段只比较 DeepSeekGUI version。
- **维护一份手写的 embedded DSH version 常量**：拒绝——第二份手写事实源必然漂移；实际打包 Runtime 的 manifest 已是权威且天然存在。
- **About 面做进 Desktop Chrome 面板**：拒绝——Chrome 面板要扩 `DesktopControlModel` 与 renderer 状态，而操作系统原生面板已能承载四个事实；`setAboutPanelOptions`/`showAboutPanel` 经一条命令走既有封闭联合路径即可。
- **把全部版本门禁塞进 PowerShell 验证脚本**：拒绝——"声明 vs 实装 runtime"检查属于发行构建（tarball 与安装树同时在场），旧缓存必须在 electron-builder 打包任何东西之前中止；PowerShell 只管 exe 元数据与打包 smoke 断言。
- **把 DeepSeekGUI job 加进上游 `ci.yml`**：拒绝——上游矩阵保持完整不动；DeepSeekGUI 专属 workflow 让桌面覆盖独立可审，且其 job 不可能在 workflow 变绿时被跳过。
- **把桌面能力基线并入上游 Web 兼容矩阵**：拒绝——那个矩阵跟踪的是上游 Web 等价性；桌面能力基线是另一个产品问题，有自己的冻结版本与状态图例。

## Consequences

- 一个 DeepSeekGUI app version 贯穿安装包文件名、exe 元数据、About 面板与 CI 工件；四个交付事实各有一个权威来源，发行构建不可能产出"声明与实装 runtime 版本不一致"的工件。
- About 启动时读取四个事实并温和降级，坏发行物对用户永远不是启动阻断；门禁让坏发行物根本建不出来。
- 打包现在要求 git checkout（source/commit 标识），与 CI 现实一致，每个发行构建都可溯源。
- 桌面 PR 得到聚焦、快速的验证，无需为上游矩阵买单；main push 与 dispatch 端到端复证打包发行物，包括 Case A–F。
- parity 矩阵如实区分已验证与已规划；范围内未建的能力（tray、terminal、plugin 管理、update）标 `not-started`，后续包只能凭自动化证据推进。
