# 数据与故障排查

[English](data-troubleshooting.md) | 中文

DeepCode 把应用状态与 Managed Harness Home 保存在 Windows 用户目录下。模型请求仍会发送给你配置的提供方；数据保存在本地，不代表远程模型变成本地模型。

## DeepCode 把数据保存在哪里

| 数据 | 默认位置 | 说明 |
| --- | --- | --- |
| Managed Harness Home | `%APPDATA%\DeepCode\dsh` | Harness 管理的凭据、设置、会话、Profile 与插件。 |
| Launcher selection | `%APPDATA%\DeepCode\launcher-state.json` | 当前 Home 与 Profile、last-known-good 选择和已脱敏的启动失败。 |
| 桌面偏好 | `%APPDATA%\DeepCode\desktop-ui-state.json` | 窗口尺寸、主题与本地 UI 确认状态。 |
| 服务日志 | `%APPDATA%\DeepCode\dsh-service.log` | 已脱敏并轮转；包含当前文件与有上限的历史文件。 |
| 诊断导出 | `%APPDATA%\DeepCode\diagnostics` | 只有你要求导出时才创建的本地诊断包。 |
| 更新缓存 | `%APPDATA%\DeepCode\updates` | 最多保存一条已验证安装器记录及其文件。 |

Windows 通过 Known Folder API 解析真实应用数据目录。表格使用 `%APPDATA%` 作为熟悉的默认写法。

## 卸载与重新安装

卸载程序会询问是否删除 DeepCode 数据目录。选择**否**会保留凭据、设置、会话与 Profile，供以后重新安装时继续使用。只有你确定要删除这些数据时才选择**是**。

升级过程中的静默卸载会保留数据，不显示该询问。

## 隐私边界

- DeepCode 通过 Harness 把提示词、所选上下文与附件发送给配置的模型提供方。
- 会话数据与凭据保存在当前 Harness Home 中；已配置的提供方或工具仍可能发送任务要求的内容。
- 服务日志会在写入前脱敏凭据形态文本。
- 诊断导出保存在本地，绝不自动上传。
- Existing Home 会原地使用；DeepCode 不会把它复制进 Managed Home。

向电脑外部分享任何内容前，请检查工具批准请求与导出的诊断信息。

<a id="windows-smartscreen-blocks-the-installer"></a>

## Windows SmartScreen 阻止安装包

DeepCode V1 尚未签名。请从同一个 GitHub Release 下载安装包与 `SHA256SUMS.txt`，校验 SHA-256；只有 hash 一致时，才使用**更多信息 → 仍要运行**。

## DeepCode 报告缺少 API key

打开**设置 → 模型**，为当前会话选择的准确提供方路由保存 key。详见[模型与视觉](models.zh.md)。

## Harness 无法启动

1. 打开 Harness 区域并阅读失败阶段。
2. 检查是否有其他进程占用端口 `3080`。
3. 最近切换过 Profile 或安装过插件时，请检查 Recovery Details 与 Plugin Manager 恢复入口。
4. 打开日志文件夹或导出诊断信息。
5. 修正原因后重启 Harness。

Profile 切换失败后，DeepCode 可能回到 last-known-good Profile。恢复提示说明回退已经成功，不代表尝试过的 Profile 已经加载。

## DeepCode 已经打开，但窗口不见了

请检查系统托盘。关闭窗口会隐藏常驻应用。再次打开 DeepCode 快捷方式后，已有实例应当重新获得焦点。

显示器、DPI 或分辨率变化后，DeepCode 也会把已保存窗口范围限制回可见工作区。

## 插件操作失败

重试前，请阅读操作输出与恢复状态。恢复确认窗口打开时，不要编辑受保护的 Profile 文件。DeepCode 报告文件 drift 时，请人工检查文件；自动恢复会停止，避免覆盖更新的改动。

## 浏览器没有打开

内置浏览器使用已安装的 Microsoft Edge 运行时，并在第一次浏览器工具调用时惰性启动。请确认 Edge 可用，而且目标是公开 `http` 或 `https` 地址。本机、内网、保留网段、带凭据与不受支持的 URL 会被刻意阻止。

## 检查更新报告没有可用更新

公开通道可能尚无 Release manifest，或者已安装版本已经是最新版本。这不会改变已安装应用。需要时可以从 GitHub 手动下载 Release。

## GUI 无法使用时导出诊断

运行：

```powershell
DeepCode.exe --export-diagnostics
```

该命令会输出导出目录。把诊断包附加到公开 issue 前，请先检查内容。

## 获取帮助

新建 issue 前，请先搜索已有 [DeepCode issues](https://github.com/See-Sol-Lab/DeepCode/issues)。请提供 DeepCode 版本、Windows 版本、尝试过的操作、可见错误，以及你已经检查过的诊断文件。
