# 桌面工具

[English](desktop-tools.md) | 中文

DeepSeekGUI 把 Harness 运行时与 Windows 原生控制组合在一起，提供浏览器工作、终端访问、更新、诊断、反馈与常驻运行。

## 内置浏览器

DeepSeekGUI 浏览器插件为 agent 提供可见的 Microsoft Edge 窗口，用于需要真实渲染或交互的网页。它支持导航、页面 snapshot、截图、标签页、等待、点击、输入、滚动与键盘动作。

浏览器遵循以下限制：

- 导航前拒绝本机、内网与保留网段地址。
- 每次重定向都会重新检查目标。
- 不提供任意页面脚本执行。
- 提交表单、登录、发送消息与其他敏感动作需要批准。
- V1 不持久化 Cookie。

agent 打开浏览器后，Browser Panel 会出现。你可以从 DeepSeekGUI 菜单显示或隐藏面板，不会因此停止浏览器任务。

![DeepSeekGUI 会话使用内置浏览器检查公开网页](assets/browser-panel.png)

## DSH Terminal

从 DeepSeekGUI 菜单或系统托盘打开 **DSH Terminal**。终端使用当前 Harness Home，并优先把当前 Profile 目录作为工作目录。

打包应用会向这个终端进程提供私有的 `dsh`、`node` 与 `pnpm` shim。它不会修改系统 PATH、注册表、PowerShell profile 或 shell 配置。

不带 Profile 参数的 `dsh` 命令默认使用当前 Profile。明确传入的 `--profile` 始终优先。

## Harness 控制

设置中的 Harness 区域会显示当前 Home、Profile、状态、Profile 切换器、Plugin Manager、权限控制、恢复详情、诊断与反馈。顶部状态指示器是只读的；需要修改时请进入 Harness 区域。

## 更新

从菜单或托盘使用**检查更新**。DeepSeekGUI 只比较 DeepSeekGUI 应用版本，不比较内嵌 DSH 版本。

下载更新前需要确认。DeepSeekGUI 只接受配置 manifest 中的 HTTPS 产物，执行声明大小限制与 SHA-256 校验，在失败或取消后删除不完整下载，并在交给安装器前再次校验文件。

公开更新通道尚无已发布 manifest 时，手动检查会报告当前没有可用更新。已安装版本仍可继续使用。

## Diagnostics Center

Diagnostics Center 显示白名单内的产品事实，并提供两个动作：

- **Open Log Folder** 打开本地服务日志目录。
- **Export Diagnostics Bundle** 在 DeepSeekGUI 数据目录下创建本地诊断包。DeepSeekGUI 不会上传它。

诊断包可以包含已脱敏的服务日志、构建信息、上次退出事实与有容量上限的 crash dump。凭据、`.env` 文件与会话内容从结构上排除。Crash dump 仍可能包含本地路径或内存片段，因此公开分享前必须检查每个导出文件。

GUI 无法启动时，请从终端运行已安装的可执行文件：

```powershell
DeepSeekGUI.exe --export-diagnostics
```

该命令不会启动 Harness、Profile、窗口、托盘或本地服务器，只会输出诊断包路径并退出。

## 反馈

反馈区域可以收集一份可编辑、已脱敏的诊断摘要，并准备 GitHub issue。复制、打开、导出或提交前，请检查文本。DeepSeekGUI 不会打包个人 GitHub Token。

## 托盘与生命周期

DeepSeekGUI 是常驻桌面应用。关闭窗口会把它隐藏起来；再次打开快捷方式会聚焦已有实例。**退出 DeepSeekGUI**才会停止 Harness、销毁托盘与视图，然后退出应用。

## 相关指南

- [Profile 与插件](profiles-plugins.zh.md)
- [权限与批准](permissions.zh.md)
- [数据与故障排查](data-troubleshooting.zh.md)
