# Agent Note: Runtime closure and Windows x64 volume optimization

Status: proposed

[English](2026-08-15-desktop-runtime-closure-and-volume.md) | 中文

## Problem

[可移植发行目录](2026-08-16-desktop-portable-distribution.zh.md)把两个 release family 的全部 tarball 都作为 staging 的直接依赖安装，npm 无法区分 Web profile 的真实运行时与仓库的其他能力、构建工具和测试工具。实测 win-unpacked 载荷约 950MB，其中 `resources/dsh` 约 603MB：仅 `@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` 就约 253MB，另有 node-pty 约 63MB、typescript 约 23MB、rolldown 约 20MB、sharp 约 18MB、esbuild 约 11MB 与测试依赖。

## Proposal

**闭包计算（`scripts/runtime-closure.ts`）。** staging consumer 的 `file:` 依赖现在恰好是生产运行闭包：从随产品发布的 Web profile 实际挂载的包出发，沿 `dependencies`、`optionalDependencies` 与 `peerDependencies` 递归（npm 7+ 自动安装必需 peers，因此本地 peer 如 worker-thread provider 的 `dsh-workflow` 必须随发行提供；`peerDependenciesMeta` 标记的 optional peer npm 并不会自动安装，但闭包有意遍历它们——封闭发行无法事后安装，且挂载的插件在 optional peer 存在时会使用它）。roots 来自 `packages/bundle/base/cordis.patch.yml`、`packages/bundle/web-app/cordis.patch.yml` 与 `@deepseek-ai/dsh` tarball 内随发行提供的每一个 agent preset（其 `files` 携带整个 `config` 目录，preset 选择器允许会话挂载其中任何一个）的 `name:` 行，加上启动器自身（`@deepseek-ai/dsh`）与 web-app bundle 动态解析的前端包（`@deepseek-ai/dsh-web-frontend`，对构建产物的 `require.resolve`——静态依赖边不可见）。vendored Cordis family 作为框架层整体纳入。构建打印 tarball 总数/闭包数/排除数与 roots。缺失的本地运行依赖会大声失败——缺失的 root 与递归可达但 tarball 未打包的 `@deepseek-ai/*` 依赖都会抛错，而不是把包名交给公共 registry 解析；点名的例外是 Landlock 启动器（`@deepseek-ai/node-addon-landlock-run`），它由自己的 release family 发布到 registry（native/README.md），staging 安装有意从那里解析。

**Windows x64 平台裁剪（`scripts/platform-prune.ts`）。** 两条规则都由确定的平台事实驱动：node-pty 的多平台 prebuilds（darwin-arm64/darwin-x64/win32-arm64/win32-x64）在本产品上只可能加载 `win32-x64`；`*.pdb` 调试符号永不被加载。每条规则都是小而明确、可测试的函数；不存在构建后的随意 rm 清单。

**保留的大型依赖及其理由。** `@opentelemetry/*`（挂载的遥测 seam）、`@img/sharp`（挂载的 `attachment-local` 图片处理）、`@google/genai`、`@mistralai`、`openai`（挂载的 `llm-pi-ai` provider 的模型后端）、`@shikijs`/`@vscode`/`@mixmark-io`（Web UI markdown 渲染）、`node-pty`（挂载的 subprocess provider 的 PTY 后端）——全部位于真实挂载插件的依赖链上。绝不单凭名称删除；Anthropic/OpenAI/Google 等包只有在所属插件确实挂载时才保留。

## Alternatives considered

**手写一份"看起来可以删除"的包名单。** 不予采纳：本里程碑要求可验证的闭包，而非主观名单；闭包由 tarball 清单与 profile 组合计算得出。

**发现动态引用时以"重新安装全部 tarball"作为回退。** 不予采纳：调查中发现的动态引用（workflow/code-runtime/telemetry 的 peer）通过给闭包增加 peer 边解决，这正是它们的真实所有权。

**跳过平台裁剪。** 不予采纳：node-pty 的其他平台 prebuilds 约 58MB，在 Windows x64 上永远无法加载。

## Verification

优化后 runtime 约 190MB（原约 603MB）；完整 win-unpacked 低于 600MB；NSIS 安装包显著变小。打包应用保持：无外部 Node/pnpm/npm/Git/源码、干净 PATH 启动、官方 UI 加载、Models/工作区/会话界面、应用专属 `%APPDATA%\DeepCode\dsh`、无 EPIPE 回归、关窗端口释放、零残留进程、按用户 NSIS 安装（快捷方式与卸载）、净化先于打包、无 key/会话/.env/.git/用户名/私人路径泄漏。

## Acceptance criteria

- 闭包单元测试覆盖递归生产依赖、optional 依赖、peer 依赖、devDependency 排除、动态 Web profile seed 与缺失本地运行依赖的明确失败；平台裁剪测试固定两条规则。
- `pnpm run build:desktop-dist` 一次产出优化后的 win-unpacked 与安装包。
- 此前全部阶段门禁保持绿色（桌面 20 测试、build:desktop、typecheck、文档检查、verify-desktop-dist.ps1、git diff --check）。

## Risks

- 未列出的动态引用会以启动失败的形式暴露；打包 smoke 是最终防线。
- 体积目标只是指示性的；若闭包无法达到，报告列出剩余体积前 20 的目录及其真实依赖链，而不是盲目删除。
