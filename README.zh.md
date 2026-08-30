<div align="center">

# <img src="./apps/desktop/src/chrome/icon.png" width="38" alt="" align="absmiddle" /> DeepSeekGUI v1

</div>

<div align="right">

[English](README.md) | 中文

</div>

<p align="center">
  <em>DeepSeek 的 AI 编程助手，装在桌面上。</em>
</p>

<p align="center">
  基于 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 的 Windows 桌面客户端。
</p>

<p align="center">
  <a href="https://github.com/See-Sol-Lab/DeepSeekGUI/releases/latest"><img alt="最新版本" src="https://img.shields.io/github/v/release/See-Sol-Lab/DeepSeekGUI?style=flat-square&label=release" /></a>
  <a href="https://github.com/See-Sol-Lab/DeepSeekGUI/releases"><img alt="下载量" src="https://img.shields.io/github/downloads/See-Sol-Lab/DeepSeekGUI/total?style=flat-square" /></a>
  <img alt="Windows 10 与 11 x64" src="https://img.shields.io/badge/Windows-10%20%7C%2011%20x64-0078D4?style=flat-square&logo=windows" />
  <a href="DEEPSEEKGUI-LICENSE.md"><img alt="源码可见" src="https://img.shields.io/badge/source-available-6f42c1?style=flat-square" /></a>
</p>

<!-- PRODUCT HUNT BADGE SLOT — 等 launch 有排名后恢复（在那之前 badge 显示 "???"）：
<p align="center">
  <a href="https://www.producthunt.com/products/deepseekgui?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-deepseekgui" target="_blank" rel="noopener noreferrer">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1235736&amp;theme=dark" />
      <img alt="DeepSeekGUI - DeepSeek's coding agent, on your desktop. | Product Hunt" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1235736&amp;theme=light" width="250" height="54" />
    </picture>
  </a>
</p>
-->

DeepSeekGUI 把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的官方 Web UI 装进了一个 Windows 桌面应用。V1 跑的就是上游原版界面，外面加了桌面集成——安装包、系统托盘、内置浏览器和终端。选个文件夹、给 AI 一个任务，它就能帮你读代码、改文件、跑命令、上网查资料，做完还会跟你解释它干了什么——全程用的是 DeepSeek 自己的模型。

一个安装包、一个 API key，直接就能用。

**非官方产品：** 基于 DeepSeek Harness 构建，但由第三方独立开发，与 DeepSeek 官方无关。上游运行时和官方 Web UI 是 DeepSeek 的工作成果。

> **开发方向：** V1 是对上游 Web UI 的桌面包装。完全独立的自研工作台正在开发中，预计在 **v2.0.0** 发布。

## 下载

| 平台 | 下载 | 要求 |
| --- | --- | --- |
| Windows | [下载安装包](https://github.com/See-Sol-Lab/DeepSeekGUI/releases/download/v1.0.0/DeepSeekGUI-Setup-1.0.0.exe) | Windows 10/11，x64 |

安装在当前用户下，双击即可。安装包自带运行时，开箱即用。

> **⚠️ 安装提示：** V1 还没做代码签名，双击安装包后 Windows 会弹出"已保护你的电脑"蓝色弹窗。点击 **"更多信息"** → **"仍要运行"** 即可继续安装。这是正常现象，代码签名后续版本会加上。

<details>
<summary>校验安装包（可选）</summary>

校验 hash 再运行：

```powershell
gh release download --repo See-Sol-Lab/DeepSeekGUI --pattern 'DeepSeekGUI-Setup-*.exe' --pattern 'SHA256SUMS.txt' --clobber
Get-FileHash .\DeepSeekGUI-Setup-1.0.0.exe -Algorithm SHA256
```

hash 和 [`SHA256SUMS.txt`](https://github.com/See-Sol-Lab/DeepSeekGUI/releases/download/v1.0.0/SHA256SUMS.txt) 对上了再装。遇到问题看[故障排查指南](docs/user/deepseekgui/data-troubleshooting.zh.md#windows-smartscreen-blocks-the-installer)。

</details>

## 快速开始

1. 安装 DeepSeekGUI，打开它。
2. 进 **设置 → 模型**，填上你的 DeepSeek API key。
3. 选一个模型（需要处理图片的话选支持视觉的模型）。
4. 回到主页，选一个工作区文件夹。
5. 开个会话，告诉 AI 你要什么，然后检查它的操作。

详细步骤看[快速开始指南](docs/user/deepseekgui/quickstart.zh.md)。

## 为什么用 DeepSeekGUI

**装上就能用。** 一键安装，所有依赖都打包好了。

**专门给 DeepSeek 做的。** DeepSeek 的推理、视觉、工具调用都有各自的产品路径。

**你说了算。** 默认沙盒模式，AI 改文件、跑工具都要你先批准。你能看到它在干什么，随时可以叫停。

**看得见的浏览器。** 内置浏览器用的是 Edge，AI 访问什么页面你全程可见。敏感操作照样需要你批准。

**数据全在本地。** 会话、密钥、设置全部存在你电脑上。

**底下还是 Harness。** Profile、插件、钩子、CLI 全都照常工作。DeepSeekGUI 直接包住 Harness 运行时，完全兼容。

## 截图

![DeepSeekGUI 编程会话](docs/user/deepseekgui/assets/workbench-overview.png)

*给 AI 一个任务，看它一步步帮你改代码、跑命令、解释每一步做了什么。*

![视觉输入](docs/user/deepseekgui/assets/vision-response.png)

*可以贴截图或图片进去，支持视觉的模型会识别并处理。*

![内置浏览器](docs/user/deepseekgui/assets/browser-panel.png)

*AI 可以用 Edge 浏览器上网，你能看到它访问的每一个页面。*

![设置面板](docs/user/deepseekgui/assets/settings-panel.png)

*在一个地方配模型、管插件、切换 Harness Profile。*

## V1.0 功能

- **Windows 安装包** — 一键安装，装在用户目录。也有免安装版。
- **DeepSeek + 自定义模型** — 除了 DeepSeek，也可以接其他 OpenAI 兼容的服务。
- **文字和图片输入** — 给支持视觉的模型贴截图。
- **工作区会话** — 选个文件夹开始写代码，下次回来继续。
- **内置浏览器** — AI 用 Edge 上网，全程可见。
- **插件支持** — 在应用里安装和管理 Harness 兼容插件。
- **默认沙盒** — 所有工具调用都需要你批准，除非你主动开放全部权限。
- **内置终端** — 在独立环境里跑 Harness CLI 命令。
- **中英双语** — 界面完整支持中文和英文。
- **系统托盘** — 最小化到托盘，自动检查更新。

V1.0 面向 Windows x64。代码签名随后跟上（届时 SmartScreen 警告会消失）。macOS、Linux 和账户系统后续版本加入。

## 开发路线

| 版本 | 状态 | 内容 |
| --- | --- | --- |
| **v1.0** | 已发布 | 将官方 Harness Web UI 包进桌面应用，增加安装包、系统托盘、内置浏览器和终端。 |
| **v2.0** | 开发中 | 完全独立的自研工作台——从零构建桌面专属界面，替换上游 Web UI。 |

## 文档

| 指南 | |
| --- | --- |
| [快速开始](docs/user/deepseekgui/quickstart.zh.md) | 第一次会话完整流程 |
| [模型与视觉](docs/user/deepseekgui/models.zh.md) | API key、模型配置、图片输入 |
| [工作区与会话](docs/user/deepseekgui/workspaces-sessions.zh.md) | 文件夹、会话管理 |
| [Profile 与插件](docs/user/deepseekgui/profiles-plugins.zh.md) | Harness Profile 和插件管理 |
| [权限与批准](docs/user/deepseekgui/permissions.zh.md) | 沙盒、权限、审批 |
| [桌面工具](docs/user/deepseekgui/desktop-tools.zh.md) | 浏览器、终端、更新、诊断 |
| [数据与故障排查](docs/user/deepseekgui/data-troubleshooting.zh.md) | 数据位置、隐私、常见问题 |

文档里也保留了上游 Harness 的开发教程和插件开发参考。

## 数据与隐私

所有数据都存在本地 `%APPDATA%\DeepSeekGUI\dsh`——密钥、设置、会话，全在你电脑上。唯一的网络流量是你和你配的模型服务之间的通信。

日志会自动把像密钥的内容打码。诊断文件存在本地。卸载时会问你要保留还是清除数据，保留的话下次装回来还能接着用。

## 从源码构建

### 从源码运行 DeepSeekGUI

需要仓库指定版本的 Node.js 和 pnpm：

```sh
git clone https://github.com/See-Sol-Lab/DeepSeekGUI.git
cd DeepSeekGUI
pnpm install
pnpm run build
pnpm run dev:desktop
```

构建 Windows 发行版：

```sh
pnpm run build:desktop-dist
```

打包细节见 [DeepSeekGUI Desktop](apps/desktop/README.zh.md)。

<a id="run"></a>

### 通过 npm 运行 Harness

装好 Node.js，启动上游 Web UI：

```sh
npx @deepseek-ai/dsh web
```

会在浏览器打开 `http://127.0.0.1:3080`。

<a id="run-deepseek-harness-from-source"></a>

### 从源码运行 Harness

公开代码树里有桌面版使用的上游 Harness 源码：

```sh
pnpm install
pnpm run build
pnpm dsh web
```

## 参与贡献

- Bug 和反馈提到 [DeepSeekGUI Issues](https://github.com/See-Sol-Lab/DeepSeekGUI/issues)。
- PR 之前先看 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。
- 上游 Harness 的问题去 [DeepSeek Harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)。

## 许可证

两部分：

- **上游 Harness** 代码继续遵循 DeepSeek 的 [MIT License](LICENSE-MIT-UPSTREAM)。
- **DeepSeekGUI** 原创代码以 [PolyForm Perimeter License 1.0.1](apps/desktop/LICENSE) 源码可见发布。个人、学习、研究、爱好、公司内部用都行；做竞品需要找 See-Sol-Lab 另外拿授权。

根目录 [`LICENSE`](LICENSE) 说明了两部分怎么划分。重新分发前请读 [DeepSeekGUI 许可说明](DEEPSEEKGUI-LICENSE.md)和[第三方声明](THIRD_PARTY_NOTICES.md)。

---

DeepSeekGUI 是公开发布仓库。日常开发在私有仓库里进行，Release 发布的是产品代码树。
