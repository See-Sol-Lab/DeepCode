# Agent Note: Installer and app-scoped user data

Status: proposed

[English](2026-08-15-desktop-installer-user-data-isolation.md) | 中文

## Problem

[可移植发行目录](2026-08-16-desktop-portable-distribution.md)可以从文件夹运行，但非程序员仍然没有安装体验：没有开始菜单或桌面快捷方式、没有卸载入口，而且打包应用与机器上其他所有 dsh 共享全局 `~/.dsh`。本里程碑增加按用户安装的安装程序，并让应用拥有自己的数据目录，使凭据、设置与会话清晰且可清除。

## Proposal

**应用专属 DSH_HOME。** 打包态主进程以 `DSH_HOME=join(app.getPath('userData'), 'dsh')`（默认产品名下即 `%APPDATA%\DeepCode\dsh`）派生 DSH 服务。全部凭据（`.credentials.yaml`）、设置、会话与 profiles 由官方 DSH 机制写入该目录；应用从不读取全局 `~/.dsh`，也绝不把密钥写进自己的配置、日志、安装包或命令行。环境变量 `DSH_HOME` 存在时覆盖默认值（开发与自动验证），开发态保持现状（不注入）。`resolveDshLaunch` 增加一个可选字段；单元测试固定注入值、覆盖行为与开发态直通。

**NSIS 安装程序。** `electron-builder.yml` 在 `dir` 之外增加 `nsis` target：向导式安装、`perMachine: false`（当前用户安装，无需管理员权限）、开始菜单与桌面快捷方式（鲸鱼图标）、`shortcutName: DeepCode`、产物 `DeepCode-Setup-${version}.exe`。安装包通过 `--prepackaged` 从已组装好的 `win-unpacked` 生成，因此拷贝好的 `resources/dsh` 运行时与消毒后的内容原样进包。不做自动更新、签名、托盘、开机启动、多平台或文件关联。构建脚本默认把工具链镜像（`ELECTRON_BUILDER_BINARIES_MIRROR`）指向 npmmirror，保证受限网络也能下载 NSIS 二进制。

**首次使用文档。** 双语 README 增加六步非程序员路径（安装 → 启动 → 设置/Models → 填 key → 选工作区 → 新会话），说明数据位置、卸载保留数据的行为与手动清除方法。任何地方不出现真实 key、用户名或私人路径。

**验收脚本修复。** `scripts/verify-desktop-dist.ps1` 通过 `Start-Process -Wait -PassThru` 读取 GUI 可执行文件的真实退出码（对 GUI 子系统用裸 `&` 调用时 `$LASTEXITCODE` 为空），并保持无 stdio 管道的保证：smoke 模式仍继承控制台，失败路径明确指出失败的断言。

## Alternatives considered

**打包应用继续使用全局 `~/.dsh`。** 不予采纳：本里程碑明确要求独立用户环境；共享目录会把桌面应用会话与机器上其他 dsh 混在一起，也让"清除我的数据"无法实现。

**用 `app.setPath('userData', ...)` / Electron 侧存储保存凭据。** 不予采纳：凭据必须留在 DSH 凭据存储（`$DSH_HOME/.credentials.yaml`）中，官方 Models UI 与运行时共享同一来源；Electron 永远不接触密钥。

**一键 NSIS（静默）安装器。** 不予采纳：向导式安装给普通用户熟悉的流程、可见的快捷方式与可发现的卸载入口。

**把安装包步骤并入单次 `--dir` 调用（extraResources）。** 不予采纳：运行时拷贝由构建脚本拥有，`--prepackaged` 保证安装包装的正是已验证的目录。

## Acceptance criteria

- 打包应用以 `DSH_HOME` = `%APPDATA%\DeepCode\dsh` 运行；凭据/设置/会话落在此处，已有的 `~/.dsh` 不受影响。
- `pnpm run build:desktop-dist` 同时产出 `dist/desktop/win-unpacked/` 与 `dist/desktop/DeepCode-Setup-<version>.exe`。
- 普通用户安装 Setup exe 无需提权；开始菜单与桌面快捷方式出现；从快捷方式启动应用、加载官方 UI、关闭后释放端口 3080。
- 卸载入口存在并移除应用。
- 单元测试（19+）、`build:desktop`、typecheck、开发态 smoke 与修复后的验收脚本通过；发行扫描保持干净（无 `.git`、`.env`、会话、密钥、用户名或私人路径）；`git diff --check` 干净。

## Risks

- NSIS 工具链二进制首次构建时从 GitHub 下载；镜像默认值让受限网络无需人工干预即可完成。
- 安装包继承约 950MB 的载荷（按决策，体积优化属于后续阶段）。
- 按用户安装位于 `%LOCALAPPDATA%\Programs` 下；未来的整机重装（后续阶段）必须迁移或说明数据目录，且卸载行为（保留用户数据）按现状写入文档。
