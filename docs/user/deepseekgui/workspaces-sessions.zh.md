# 工作区与会话

[English](workspaces-sessions.md) | 中文

工作区告诉 Harness 当前会话正在处理哪个项目。会话保存这项工作的对话、工具事件与可恢复状态。

## 选择工作区

新建会话前，先从 DeepSeekGUI 首页选择项目文件夹。该工作区会成为 agent 及其工具的默认工作目录。

在推荐的 Sandbox 模式下，工作区也是通常的可写范围。工具只能读写当前 Harness 权限策略允许的内容；选择文件夹不会授予 agent 对电脑其他位置的 Full Access。

请选择专用项目文件夹，不要选择用户目录或整个磁盘等范围过大的位置。使用版本控制或可丢弃副本，可以让检查与恢复更容易。

## 开始会话

在所选工作区中新建会话，并向 agent 说明：

- 一个具体结果。
- 相关限制，例如不得修改的文件。
- 完成前需要执行的验证。

第一次可以先要求 agent 检查并报告，暂不编辑。范围确认无误后，再在同一会话中要求修改，以便继续使用已经建立的上下文。

## 恢复会话

DeepSeekGUI 通过 Harness 把会话保存在当前 Harness Home 中。从会话列表重新打开旧会话，即可继续使用已记录的对话与事件。

切换当前 Profile 或 Harness Home 后，界面会读取另一份会话存储。回到原来的 Home 与 Profile 后，对应会话会重新出现；DeepSeekGUI 不会在不同 Home 之间复制会话。

## 附加文件与图片

所选模型支持图片输入时，可以附加图片。需要检查项目文件时，请告诉 agent 对应路径，不要把大型文件直接粘贴进对话。

附件只会通过 Harness 进入模型输入。DeepSeekGUI 不维护第二份附件数据库。

## 检查 agent 的工作

要求 agent 概述修改过的文件与验证结果。源代码改动请使用版本控制进行 review（审查），并在允许工作区日常流程之外的操作前检查工具批准请求。

正在运行的一轮被中断时，已保存的会话历史不会消失。Harness 重启或 DeepSeekGUI 退出可能停止当前操作，但已记录的对话仍保留在磁盘上。

## 窗口与托盘行为

关闭主窗口会把 DeepSeekGUI 隐藏到系统托盘。Harness 与当前任务会继续运行。**退出 DeepSeekGUI**会停止 Harness，并可能中断当前任务，因此 DeepSeekGUI 会在退出前要求确认。

## 相关指南

- [权限与批准](permissions.zh.md)
- [Profile 与插件](profiles-plugins.zh.md)
- [数据与故障排查](data-troubleshooting.zh.md)
