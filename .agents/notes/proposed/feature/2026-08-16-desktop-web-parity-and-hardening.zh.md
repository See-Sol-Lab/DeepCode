# Agent Note: 桌面 Web 等价阶段与壳硬化

Status: proposed

[English](2026-08-16-desktop-web-parity-and-hardening.md) | 中文

## Problem

第一至第四阶段证明了打包壳能启动、显示官方 Web UI、干净退出——仅此而已。产品目标是在桌面宿主内完整保留官方 `--profile web` UI 的全部功能，而壳本身还有桌面宿主缺口：官方 Markdown 的外链是死的（所有 `window.open` 被拒绝）、第二次启动撞端口报错而不是聚焦已有窗口、打包 GUI 丢弃 DSH 输出但错误对话框却让用户去看一个不存在的终端、`win-unpacked` 之外的发布集合（electron-builder 的 `builder-debug.yml`）带着构建机路径躲过泄漏扫描、运行时安装每次构建都重新解析外部 semver 范围。

## Proposal

- **外链**（`classifyLinkOpen`）：本机 DSH 源在窗口内导航；其他 `http`/`https` URL 无论来自 `window.open` 还是 `will-navigate` 都交系统默认浏览器（`shell.openExternal`）；其余协议一律拒绝。远程页面绝不在窗口内加载。
- **单实例**：`requestSingleInstanceLock`；后到实例以退出码 0 结束，`second-instance` 恢复并聚焦既有窗口。
- **面向 GUI 用户的诊断**：打包 GUI 把 DSH stdout/stderr pipe 进 `%APPDATA%\DeepCode\dsh-service.log`（上一份轮转为 `.old`，5MB 上限并留截断标记，`sk-…` 形态落盘前脱敏）；错误对话框指向该日志而不是终端。开发态与 smoke 仍继承控制台。
- **停止健壮性**：`taskkill` 报 error 或非零退出且子进程仍在运行时，`stopProcess` 回退为直接 `kill()`；SIGKILL 宽限定时器仍是最后防线。
- **发布集合泄漏扫描**：构建删除 `builder-debug.yml`（完整 NSIS 命令行：仓库、用户、临时与缓存路径），并在安装包构建后对整个 `dist/desktop` 发布集合（含安装器元数据）做只扫不改写的终扫；`builder-debug.yml` 与 `.package-lock.json` 的幸存副本按文件名即为 finding，该阶段出现仓库根路径也报 finding 而不改写——安装包已包裹的字节绝不被修改。
- **可复现安装**（`scripts/runtime-lock.ts`）：staging consumer 移入 `dist/desktop`，闭包 tarball 用相对 `file:` spec；npm 锁文件保持启用，从提交在仓库的 `apps/desktop/runtime.package-lock.json` 种入并回写。外部 registry 依赖由此钉住；锁文件含任何机器绝对路径都会使构建失败。
- **P5 parity foundation**：覆盖官方 Web UI 各模块的等价矩阵（逐行状态），以及 `pnpm run test:desktop-parity`——playwright-core 的 Electron 驱动直接驱动打包 exe。运行完全隔离（`APPDATA`/`LOCALAPPDATA`/`DSH_HOME` 全部落在一个测试临时根内，Electron userData、诊断日志与单实例锁绝不触碰真实用户目录），凭据形态环境变量（`KEY`/`TOKEN`/`SECRET`/`PASSWORD`/`CREDENTIAL`，任意大小写）全部剔除；打包 exe 缺失时门禁测试明确失败而非跳过。这是地基而非阶段完成：4 个生命周期行已验证，覆盖官方功能主体的 25 行仍为 `it.todo`，最终发布门禁是 pending = 0。

## Alternatives considered

**允许外部 URL 在窗口内加载。** 不予采纳：窗口是官方本机 UI 的宿主；远程内容进窗口会继承应用的外观与生命周期。系统浏览器才是外链的平台原生去处。

**为“运行中关窗”引入托盘/后台常驻。** 不予采纳，超出范围；关窗终止服务进程树，会话经官方 session log 在下次启动恢复。

**对提交的锁文件用 `npm ci`。** 不予采纳：本地 tarball 每次构建重打，内容一变 `npm ci` 就会因 integrity 失败；以锁文件种入的 `npm install` 既钉住外部版本又容忍本地 tarball 刷新。

**完整 Playwright 依赖（含浏览器）。** 不予采纳：`playwright-core` 即可驱动打包的 Electron 二进制，不涉及浏览器下载。

## Acceptance criteria

- 桌面单元测试覆盖链接分类、日志脱敏/限长/轮转、stdio 策略与 taskkill 两种失败回退；脚本测试覆盖锁文件可移植性与发布集合扫描规则。
- `pnpm run build:desktop-dist` 产出的发布集合终扫通过、`builder-debug.yml` 不存在，并写出/保持无机器绝对路径的 `apps/desktop/runtime.package-lock.json`。
- `pnpm run test:desktop-parity` 在打包 exe 缺失时大声失败；在完全隔离的环境中对打包 exe 通过已实现的 4 行，其余 25 行全部列为 todo——矩阵到 pending = 0 本阶段才算完成。

## Risks

- 等价矩阵大部分是 todo；对话流各行需要 replay/mock 传输才能无 key 驱动。
- playwright-core 经 CDP 驱动 Electron；Electron 升级若改变调试面会表现为 parity 套件启动失败。
- 外部依赖钉住仅在上游 semver 范围仍容纳锁定版本时成立；tarball manifest 的范围升级会以 git 中可见的锁文件变化显形。
