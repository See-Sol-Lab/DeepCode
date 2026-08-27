# Agent Note: Web UI 的 Electron 桌面壳

Status: proposed

[English](2026-08-15-desktop-electron-shell.md) | 中文

## Problem

仓库唯一随产品发布的交互界面是 Web UI，用户需要在浏览器中打开。 [DEEPSEEKGUI.md](../../../../DEEPSEEKGUI.md) 面向 DeepSeek Harness 的 Windows 桌面客户端，其第一里程碑是 Windows 桌面体验：一条命令、一个真正的应用窗口，不需要浏览器、不需要输入 localhost 地址。harness 核心已经通过 `web` profile 证明了所需行为；缺的只是一个宿主壳——启动该服务并以独立窗口呈现。

## Proposal

新增 `apps/desktop`（`@see-sol-lab/deepseekgui`，private，仅开发阶段）——一个原样封装随产品发布的 `web` profile 的 Electron 主进程：

- 启动服务：在仓库根目录 spawn `node --import tsx/esm apps/cli/src/bin.ts --profile web --host 127.0.0.1 --port 3080`，stdout/stderr 转发到启动终端。端口 `3080` 与 web profile 默认一致并保持固定。
- 端口冲突：spawn 之前先做 TCP 探测。端口被占用时弹出可理解的错误对话框并以退出码 1 结束——不静默换端口、不重试。
- 就绪等待：轮询 `http://127.0.0.1:3080/` 直到收到 HTTP 响应（60 秒上限），然后创建窗口。
- 窗口：`BrowserWindow` 使用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；拒绝新窗口，窗口内导航限制在本机 DSH 源内，标题固定为 `DeepSeekGUI`。该源之外的 `http`/`https` 链接交给系统默认浏览器打开；远程页面绝不在窗口内加载。
- 关闭：关闭最后一个窗口即退出应用；终止子进程并等待其退出。DSH 意外崩溃时显示错误对话框并退出。
- 接入：根脚本 `build:desktop`（`tsc -b apps/desktop`）与 `dev:desktop`（先构建再 `electron apps/desktop`）；`electron` 是唯一新依赖（根 devDependency，与 typescript 同级）。包加入 `tsconfig.host.json`；根 tsdown workspace 白名单已天然排除它，不会被打包。
- 验证：针对命令组装、端口探测、就绪等待、进程停止的单元测试（不 import Electron）；`DSH_DESKTOP_SMOKE=1` 走相同启动路径但不弹 GUI 对话框，页面加载后打印 `[deepseekgui] window loaded`，关闭窗口并退出——可脚本化的无密钥 smoke。

按 DEEPSEEKGUI 里程碑边界，本阶段不做：安装器、自动更新、托盘、全局快捷键、开机启动、账号系统，以及窗口品牌化（图标保持 Electron 默认；页面本身携带仓库的鲸鱼 favicon）。

## Alternatives considered

**恢复已删除的 TUI 包。** 不予采纳：桌面壳是本里程碑选定的界面形态，且 [TUI 移除笔记](../../implemented/simplification/2026-08-04-remove-tui-package.zh.md) 要求任何未来终端前端从实际宿主需求重新开始，而不是继承已删除的实现。

**在同一改动中引入 electron-builder 直接产出安装器。** 不予采纳：本阶段是可运行的开发壳；打包属于后续里程碑，现在引入会扩大依赖与验证面。

**通过 WebView 或 iframe 机制嵌入 UI。** 不予采纳：用 `BrowserWindow` 加载本机页面已满足需求，且不引入第二套嵌入机制。

**使用端口 0（由 OS 分配）避免冲突。** 不予采纳：里程碑明确要求固定本机端口，端口被占用时给出可理解的错误，而非静默切换或重试系统。

## Acceptance criteria

- 从干净终端运行 `pnpm run dev:desktop` 打开独立 Electron 窗口。
- 窗口显示官方 Web UI，包括对话、Trajectory、会话与设置界面。
- 远程页面绝不在窗口内加载；外部 `http`/`https` 链接交给系统默认浏览器。
- 关闭窗口后 DSH 子进程结束、端口释放。
- 端口被占用时产生用户可理解的错误与退出码 1。
- `apps/desktop` 单元测试、host 面 typecheck、Web UI 构建通过；`git diff --check` 干净。

## Risks

- Windows 上停止路径终止整棵进程树（`taskkill /T /F`），DSH 的工具子进程（pwsh、pty helper）不会比应用活得更久，但 DSH 进程的 SIGTERM 优雅退出路径不会执行。对开发壳可接受：进程死亡时 OS 立即释放端口。
- 从任务管理器强杀 Electron 可能遗留 DSH 子进程；正常关窗路径总会清理，README 已记录该限制。
- electron 二进制在安装时从 CDN 下载；网络受限环境需要镜像。
- 虚拟化/无 GPU 环境在 smoke 运行期间会在 Electron stderr 输出无害的 GPU 错误。
