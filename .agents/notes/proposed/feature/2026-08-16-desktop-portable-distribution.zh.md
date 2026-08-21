# Agent Note: Portable Windows distribution directory

Status: proposed

[English](2026-08-16-desktop-portable-distribution.md) | 中文

## Problem

[Electron 桌面壳](2026-08-15-desktop-electron-shell.md)目前只能从源码检出运行：启动它需要 Node.js、pnpm 与仓库的构建产物。本里程碑的下一步是"可双击的 Windows 发行"：一条构建命令产出一个非程序员无需任何开发工具即可运行的目录，同时壳保持单一 DSH 运行时、固定 `127.0.0.1:3080` 端口与全部安全设置。

## Proposal

新增 `pnpm run build:desktop-dist`（`scripts/build-desktop-dist.ts`），产出 `dist/desktop/win-unpacked/`，内含 `DeepCode.exe`：

- **打包**：两个 release family（`dsh`、`vendor`）走与 `release/pack.ts` 相同的逐成员检查（pnpm pack + payload 校验），输出到 `dist/npm-dsh` 与 `dist/npm-vendor`。
- **安装**：写一份 staging consumer manifest，把[运行闭包](2026-08-15-desktop-runtime-closure-and-volume.md)内的 tarball 声明为相对 `file:` 依赖，然后 `npm install`——与 `release/verify-packed-install.ts` 证明过的机制一致，但不带它的 `--omit=optional`：Windows ACL 沙箱的 `koffi` 与 Landlock 平台包以 optionalDependencies 发布预编译二进制，跳过它们会迫使源码构建。registry 流量仅限于外部依赖（commander、js-yaml、koffi、opentelemetry 等），由提交在仓库的 `apps/desktop/runtime.package-lock.json` 钉住（种子进 staging 安装并回写，外部漂移会以 git diff 的形式显形；锁文件含任何机器绝对路径都会使构建失败）。
- **组装**：把安装好的 `node_modules` 复制到 `dist/desktop/dsh/node_modules`；electron-builder（`apps/desktop/electron-builder.yml`，`target: dir`）把它作为 `resources/dsh` 打进产物，并把壳打包进 `app.asar`。
- **启动**：打包态主进程以 `ELECTRON_RUN_AS_NODE=1`（并加 `--expose-internals`——Cordis loader 的 HMR 助手需要它，`node-addon-require-builtin` 回退无法在 Electron 的 Node 域内运行）派生自身可执行文件，运行 `resources/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --host 127.0.0.1 --port 3080`，工作区设为用户主目录。子进程 stdio 在开发态与 smoke 模式继承宿主控制台，在正常打包 GUI 中忽略——该进程没有控制台，向已关闭的管道写入会触发 EPIPE。已安装的 `@deepseek-ai/dsh` 包就是启动器锚点，因此 profile bundle 解析与 `$DSH_HOME/profiles/node_modules` 回退都落在发行目录内部；会话仍写 `~/.dsh`。不依赖外部 Node、pnpm 或 PATH 条目，也不存在第二套进程管理实现——`apps/desktop/src/dsh-service.ts` 的 `resolveDshLaunch` 是两种模式共用的唯一启动路径。
- **图标**：`scripts/generate-desktop-icon.ts` 把仓库的鲸鱼 favicon 渲染为品牌蓝圆角方块上的白色鲸鱼（256×256 PNG；electron-builder 自动转 ICO）。这是现有素材，不是新品牌设计。
- **泄漏检查**：`sanitizeAndVerify()`（`scripts/leak-scan.ts`）先把构建机仓库根路径的出现（构建工具的一个 CSS 注解会把绝对路径带进 client bundle）按三种 Windows 路径编码（反斜杠、正斜杠、JSON 转义）全部中性化，再扫描产物目录中的 `.git`、`.env`、会话日志（`.jsonl`）、构建者主目录路径，以及本仓库产出的文件中的 `sk-…` API key 模式；任何发现都会使构建失败。每个文本文件——包括 sourcemap——都完整读取，没有大小上限；无法读取的文件本身就是一个 finding。npm 的隐藏 `node_modules/.package-lock.json` 会把 tarball 的 `resolved` 记成相对安装目录的 `file:` URL（构建用户与仓库位置，路径检查认不出的形态）；装配步骤会删除它，扫描把任何幸存副本报为 finding。

范围边界：不做安装器、自动更新、托盘、开机启动、签名或账号系统；只做 `target: dir`。`npmRebuild: false` 且 `electronDist` 指向已安装的 Electron 二进制。pnpm 的构建脚本门禁在 `pnpm-workspace.yaml` 中新增 `electron`/`electron-builder` 批准（以及显式的 `electron-winstaller: false`）。

## Alternatives considered

**把已打包的 `@deepseek-ai/dsh` npm 安装作为用户单独执行的步骤。** 不予采纳：本里程碑要求一条构建命令直接产出可运行目录，无需手工组装。

**在应用旁捆绑独立 Node.js 二进制。** 不予采纳：`ELECTRON_RUN_AS_NODE` 让 Electron 可执行文件自身充当 Node 运行时，省下约 50MB 与一个需要保持同步的版本。

**以子进程方式调用 `release/pack.ts`。** 不予采纳：它要求构建环境 PATH 中有 pnpm；发行脚本通过 `npm_execpath`（pnpm 注入的模块路径）运行 pnpm，无需 pnpm shim，并直接 import `families.ts`/`tarball.ts` 复用相同的检查。

**用 electron-packager 替代 electron-builder。** 不予采纳：electron-builder 已处理图标转换与 unpacked 布局，且是生态中受维护的默认选择。

## Acceptance criteria

- `pnpm run build:desktop-dist` 产出 `dist/desktop/win-unpacked/DeepCode.exe`。
- 打包版 exe 在开发机 Node/pnpm 从 PATH 移除的情况下（smoke 模式）显示官方 Web UI。
- 关闭窗口后 DSH 子进程结束、端口 3080 释放。
- 发行目录不含 `.git`、`.env`、会话日志、用户路径或 API key。
- 第一阶段门禁保持绿色：包级测试（13）、`build:desktop`、开发态 smoke、typecheck、文档检查、`git diff --check`。

## Risks

- npm registry 的可用性与速度决定发行构建耗时；consumer 安装与已验证的 `verify-packed-install` 流程一致。
- 发行目录体积较大（Electron 约 220MB 加已安装依赖树）。
- `ELECTRON_RUN_AS_NODE` 让 DSH 服务运行在 Electron 二进制内；Electron 升级必须保持该模式可用。
- 用户主目录工作区是占位方案，直到出现项目选择阶段；只读或网络主目录需要与端口冲突相同的错误面。
