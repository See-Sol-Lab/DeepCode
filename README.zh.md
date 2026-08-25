# DeepCode

[English](README.md) | 中文

> **像 Codex 一样使用。像实验室一样检查。像 Harness 一样扩展。**

> **许可证：** DeepCode 采用分层许可证。See-Sol-Lab 原创 DeepCode 产品代码在明确范围内采用 PolyForm Perimeter 1.0.1，以源码可见方式发布；上游 DeepSeek Harness 仍为 MIT。详见 [DeepCode 许可说明](DEEPCODE-LICENSE.md)。

DeepCode 是一个 DeepSeek 原生、Harness 优先、可观察、可编程的智能体工作台。[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 是运行内核；DeepCode Workbench 是产品；官方 DSH Web UI 保留为兼容视图与上游回归基线。

DeepCode 在 Harness 原生组合中保留 profile、Cordis 插件、session 事件、工具、凭据、权限、记忆、压缩和 hooks。Workbench 为日常智能体工作、运行时检查和可复现实验提供渐进式界面，同时不建立第二套智能体运行时或隐藏状态库。

产品有两项竞争承诺：

- 做最好的 DeepSeek 桌面 GUI：一个 DeepSeek 桌面客户端该有的每项能力，都做成打磨过的 Windows 发行版。
- 做最好的 DeepSeek Workbench：支持任意 DSH profile、真实执行用户 Cordis 插件、原生开放 memory/compaction/hooks、公开可复现的 DeepSeek benchmark，并用 Runtime Lens 提供上下文、来源、压缩、hook、回放和 A/B 实验能力。

这两条都是正在实现中的目标，不是对现状的描述。

完整产品约定见 [DEEPCODE.md](DEEPCODE.md)。

DeepCode 是非官方社区项目，与 DeepSeek 无隶属关系，也未获其背书。官方 Web UI 与上游 Harness packages 是 DeepSeek 的工作成果。

## 开发者预览

DeepCode 与 DeepSeek Harness 均处于活跃开发阶段。首个稳定版发布前可能发生破坏兼容性的变更。

<a id="run"></a>

## 运行

### 通过 `npm` 运行 DeepSeek Harness

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

### 在 Windows 上从源码运行 DeepCode Desktop

从仓库源码运行：

```sh
pnpm install
pnpm run build
pnpm run dev:desktop
```

`dev:desktop` 启动本地 DSH Web 服务并打开当前 DeepCode Desktop 宿主；关闭窗口即停止服务。独立 Workbench 建设期间，该宿主目前显示兼容视图。详见 [apps/desktop](apps/desktop/README.zh.md)。

<a id="run-deepseek-harness-from-source"></a>

### 从源码运行 DeepSeek Harness

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

## 社区与支持

- 通过本仓库提交 DeepCode 反馈与 bug 报告。
- 上游 Harness 问题请使用 [DeepSeek Harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)。
- 为 Harness 插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于发现。
- 欢迎加入 <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord 社区</a>。

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

DeepCode 采用**分层许可证**，因为本仓库同时包含上游 DeepSeek Harness 与 See-Sol-Lab 原创产品层。

- 上游 DeepSeek Harness 代码及其衍生部分继续遵循 DeepSeek 的 [MIT License](LICENSE-MIT-UPSTREAM)。
- [`apps/desktop/`](apps/desktop/) 下的 DeepCode 原创桌面/产品层采用 [PolyForm Perimeter License 1.0.1](apps/desktop/LICENSE)。个人、教育、研究、兴趣、公司内部使用及其他许可范围内的用途都可以；未经 See-Sol-Lab 另行书面授权，不得向他人提供与 DeepCode 竞争、可替代其功能或价值的产品。
- 未来位于 `apps/desktop/` 之外的 See-Sol-Lab 原创组件，只有在明确引用 PolyForm Perimeter 或仓库许可说明时才适用该许可证。

仓库根目录的 [`LICENSE`](LICENSE) 只是许可证适用范围说明，并不是覆盖整个仓库的单一许可证授权。具体适用范围见 [DeepCode 许可说明](DEEPCODE-LICENSE.md)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。这些软件许可证不授予 DeepCode 或 See-Sol-Lab 名称、标识及品牌资产的商标或品牌使用权。

---

本仓库是 DeepCode 的公开发布仓库。它 fork 自官方 DeepSeek Harness，日常产品开发在另一个未公开的私有仓库中进行；这里发布的是产品代码树本身，而不是那个仓库的历史。
