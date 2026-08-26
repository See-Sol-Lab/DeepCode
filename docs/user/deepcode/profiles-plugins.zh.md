# Profile 与插件

[English](profiles-plugins.md) | 中文

Harness Profile 定义 agent 使用的运行时组合。DeepCode 发现这些 Profile，并通过官方 Harness 命令管理插件；它不维护第二套插件系统。

## Managed Home 与 Existing Home

DeepCode 可以运行两类 Harness Home：

- **Managed Home** 是 DeepCode 应用数据目录下由应用管理的 Home。它是推荐起点，并使用 DeepCode 的安全默认值。
- **Existing Home** 是你选择的 DSH Home 绝对路径。DeepCode 会原地发现并运行其中的 Profile，不复制、不合并，也不迁移。

Harness 面板会显示当前 Home、完整路径、Profile 与运行时状态。切换 Home 或 Profile 会重启 Harness，并可能中断正在运行的任务；有任务正在运行时，DeepCode 会先要求确认。

## 选择 Profile

打开设置中的 Harness 区域，选择可启动的 Profile。DeepCode 会区分支持 Web、候选、headless 与 malformed 的 Profile，不会把每个目录都显示成可运行项。

新 Profile 启动失败时，DeepCode 可以回到 last-known-good（最近一次成功）选择。恢复提示会记录失败阶段与目标，不会假装尝试过的 Profile 已经成功。

![DeepCode 设置面板，包含通用、模型、插件与 agent preset 控制](assets/settings-panel.png)

## 理解 Plugin Manager

Plugin Manager 会分开显示三类事实：

- **Profile Bundles** 是 Profile 的组合层。
- **Installed Dependencies** 是 Profile manifest（元数据清单）中列出的包。
- **Effective/Loader status** 报告 Harness 实际可以加载的内容。

依赖已经安装，不代表插件已经生效。安装并重启后，请检查 effective status。

## 安装、更新或移除插件

1. 打开**设置 → Harness → Plugin Manager**。
2. 确认目标 Home、完整路径、Profile、操作与包 spec。
3. 执行操作并检查流式输出。
4. 等待 DeepCode 完成事后检查。
5. 收到提示后重启 Harness；也可以稍后重启，但新组合在重启前不会运行。

DeepCode V1 不提供插件市场。请使用来自可信来源的兼容包名、tarball 或受支持的本地路径。

## 受保护的插件改动

执行已确认的插件写操作前，DeepCode 只会为 `package.json`、`pnpm-lock.yaml` 与 `pnpm-workspace.yaml` 创建快照并记录 hash。实际变更仍通过 `dsh plugin` 执行。

只有下一代 Harness 成功启动后，DeepCode 才认为改动已经验证。启动失败且三个受保护文件没有再次变化时，Managed Home 可以恢复三个快照并自动重启一次。Existing Home 在恢复前始终要求明确确认。检测到外部文件变化后，DeepCode 会停用自动恢复，避免覆盖更新的编辑。

DeepCode 的这项保护绝不备份或恢复 `node_modules`。

## V1 插件限制

- 目标必须已经在当前 Home 下被发现。
- DeepCode 不通过 Plugin Manager 初始化新 Profile。
- 本地路径或包 spec 中含空白、控制字符或 Windows 命令元字符时会被拒绝。
- 官方 Windows CLI 转发路径无法安全保留部分复合 semver 范围，因此这些范围暂不支持。

## 相关指南

- [权限与批准](permissions.zh.md)
- [桌面工具](desktop-tools.zh.md)
- [数据与故障排查](data-troubleshooting.zh.md)
