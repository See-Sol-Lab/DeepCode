# 贡献指南

[English](CONTRIBUTING.md) | 中文

感谢你考虑为 DeepCode 的开发作出贡献！这份文档是 DeepCode 的共同开发指南，提交工作的人类与 Agent 都请先读一读。

DeepCode 是把 DeepSeek Harness 装进 Windows 的桌面产品。你能帮上忙的地方很多——用它、报问题、写文档，或者直接来改代码。

## 报告问题与提建议

- **报 bug**：到 [DeepCode Issues](https://github.com/See-Sol-Lab/DeepSeekGUI/issues) 提，带上 Windows 版本、DeepCode 版本和复现步骤，有截图或日志更好。
- **提功能建议或反馈**：同样在 Issues 里聊，说清楚你想解决什么问题、期望它怎么工作。
- **上游 Harness 本身的行为**：到 [DeepSeek Harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提问，那边更对口。

## 开发环境

**前置要求**

- Windows 10/11 x64
- Node.js `^22.19.0` 或 `>=24.0.0`
- pnpm 11（运行 `corepack enable` 即可启用）

**克隆与安装**

```sh
git clone https://github.com/See-Sol-Lab/DeepSeekGUI.git
cd DeepCode
pnpm install
```

**常用命令**

| 命令 | 作用 |
| --- | --- |
| `pnpm run build` | 构建全部产物 |
| `pnpm run dev:desktop` | 启动桌面端开发模式 |
| `pnpm run build:desktop-dist` | 构建 Windows 发行版 |
| `pnpm run typecheck` | 类型检查 |
| `pnpm run lint` | 代码风格检查（`lint:fix` 可自动修复） |
| `pnpm test` | 运行测试 |

工程细节与打包验证见 [apps/desktop/README.zh.md](apps/desktop/README.zh.md)。

## 仓库边界

如果把 DeepCode 的发展愿景比作一辆车，DeepSeek Harness 就是它的核心发动机。上游 Harness 的核心文件跟随官方持续更新，DeepCode 这边保持原样——请每一位 PR 提交者先了解这条原则。

具体来说：

- **DeepCode 自己的桌面代码在 `apps/desktop/`**，这里欢迎改进。
- **上游 Harness 部分**（`packages/`、`apps/cli`、`apps/web` 等）跟随官方更新，改动请提到 [上游仓库](https://github.com/deepseek-ai/deepseek-harness)。

## 提交 PR

- 一个 PR 只做一件事，改动聚焦更容易读、也更容易合。
- 提交信息使用 [Conventional Commits](https://www.conventionalcommits.org/) 风格，例如 `fix(desktop): ...`、`docs: ...`。
- PR 描述写清三件事：改了什么、为什么改、怎么验证的。
- 界面文案与文档改动请中英同步。

**提交前请确认**

- [ ] 改动集中在 `apps/desktop/` 或其他 DeepCode 自有部分
- [ ] `pnpm run build` 通过
- [ ] `pnpm run typecheck` 与 `pnpm run lint` 通过
- [ ] 涉及界面或文档的改动已中英同步
- [ ] PR 描述说明了改动内容、动机与验证方式

## 行为准则

请保持友善与尊重，就事论事。我们希望这是一个欢迎新人的地方。

## 联系我们

- DeepCode 的 bug 与产品反馈：[DeepCode Issues](https://github.com/See-Sol-Lab/DeepSeekGUI/issues)
- 上游 Harness 行为相关的问题：[DeepSeek Harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)

再次感谢你愿意花时间参与 DeepCode。
