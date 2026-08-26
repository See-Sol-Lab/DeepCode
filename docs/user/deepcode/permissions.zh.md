# 权限与批准

[English](permissions.md) | 中文

Harness 是权限真源。DeepCode 显示并修改官方 Harness 设置，不维护自己的权限模式或批准历史。

## 权限模式

### Sandbox

Sandbox 是 Managed Home 的推荐默认值。它由 workspace-write 沙箱与 ask-approval 行为组成。agent 工具可以在所选工作区中执行任务；普通策略范围之外的操作会按 Harness 规则被拒绝或要求批准。

日常 coding、文档工作和不熟悉的项目请使用 Sandbox。

### Full Access

Full Access 允许 agent 工具以你的 Windows 账户权限执行操作。当前工作区之外的文件可能被读取、写入或删除。

启用 Full Access 前，DeepCode 始终显示风险确认。只有任务所需文件或系统操作无法在 Sandbox 中完成时才使用它，并在任务结束后切回 Sandbox。

### Read-only 与 Custom

Read-only 会阻止需要写入或产生其他不允许副作用的工具操作。Custom 表示当前 Harness 策略与 DeepCode 的具名 preset 不完全一致。DeepCode 会报告观察到的状态，不会把它重新标成 Sandbox。

## 批准

每一条批准请求都由 Harness 持有。DeepCode 保留原生的批准与拒绝界面，绝不替你批准。

批准前请检查：

- 将要运行哪个工具。
- 它指向哪个路径、命令、网站或外部动作。
- 请求是否符合你交给 agent 的任务。
- 更窄的动作是否已经足够。

操作系统可能在批准对话框出现前直接拒绝操作。例如，Windows 工作区沙箱可以直接阻止越界写入。这仍然说明安全边界成功生效，不代表批准界面缺失。

## Managed Home 与 Existing Home

新 Managed Home 在 Harness 尚无明确默认值时，会在第一个 agent 会话开始前使用推荐的 Sandbox preset。

DeepCode 绝不静默修改 Existing Home 的权限设置。它会显示当前模式，并在写入 Sandbox preset 或启用 Full Access 前要求确认。

## 浏览器权限

导航、页面 snapshot 与截图等只读浏览器动作可以在浏览器策略允许的范围内运行。Read-only 会话会拒绝交互动作。提交表单或发送消息等敏感动作始终需要 Harness 批准。

浏览器工具在浏览器进程内部交互。它们不会移动你的物理鼠标、通过你的键盘输入，也不会抢占桌面焦点。

## 权限控制不可用时

DeepCode 无法读取 Harness 权限服务时会显示 **Permission controls unavailable**。它不会声称 Sandbox 已经启用，也不会回退到 Full Access。

请重启 Harness 并检查 Diagnostics Center。问题仍然存在时，导出诊断包，并在分享前自行检查内容。

## 相关指南

- [工作区与会话](workspaces-sessions.zh.md)
- [Profile 与插件](profiles-plugins.zh.md)
- [桌面工具](desktop-tools.zh.md)
