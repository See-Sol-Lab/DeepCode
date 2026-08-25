# @see-sol-lab/deepcode-browser

DeepCode 浏览器能力插件：经官方 tool-calling 循环暴露真实浏览器（headed Edge）
给 DeepCode 里的 DS。只读浏览 + 交互 + 安全层（SSRF 门禁、权限分级）。

## 工具

**只读（L0）**
- `browser_navigate`：打开 URL（SSRF 门禁先行——本机/内网/保留段一律拒绝，包括
  DeepCode 自己的 3080 控制桥；这是特性不是例外）
- `browser_snapshot`：无障碍树（CDP a11y）+ 可见文本，返回稳定 `ref` 供交互工具定位
- `browser_screenshot`：截图存本地；**若当前模型不带视觉，须告知用户查看截图需切换
  到带视觉的模型**（住户产品约束）
- `browser_wait`：load / network-idle / selector / 延时
- `browser_tabs`：标签页 list / new / switch / close

**交互（M3，L1）**
- `browser_click` / `browser_hover`：点击 / 悬停（ref 优先，text / CSS / role+name 兜底）
- `browser_type`：输入文本（clear_first / press_enter）
- `browser_scroll`：滚动（up / down / top / bottom，或把元素滚进视野）
- `browser_keyboard`：按键（Enter / Tab / Control+A 等）

**敏感（L2）**
- `browser_submit`：提交表单 / 发送消息 / 登录——**永远先经官方 ApprovalService
  征求用户授权**，approval 缺失 fail closed。

**交互边界（住户定的体验约束）**：所有交互都是**在浏览器进程内注入**（CDP Input
domain）——**绝不触碰用户的物理鼠标与键盘，绝不抢占桌面焦点**。用户在别的窗口照常
工作，浏览器自己静静翻自己的。与「OS 级接管鼠标」的自动化（如部分 Codex 行为）有
本质区别。

权限门控：read-only 会话拒绝全部 L1 交互（浏览器交互对外部世界有副作用，不因不写
工作区豁免）；L2 走官方 ApprovalService，approval 缺失 fail closed。

## 安装

```sh
# 产品期：registry 包名（依赖由 pnpm 解析进 profile node_modules）
dsh plugin add @see-sol-lab/deepcode-browser

# 开发期：tarball（npm pack 产物；与 registry 行为一致）
dsh plugin add ./see-sol-lab-deepcode-browser-0.1.0.tgz
```

插件声明 `dsh.bundle.patch`，`dsh plugin add` 后自动进入 profile 的组合层栈
（reconcile 无需手改 profile）。

> **注意（spike 实测）**：本地目录 spec（`dsh plugin add ./dir`）的传递依赖不会
> 链接进 profile node_modules（pnpm 对 file:/link: 依赖标 private hoist），
> 独立环境加载必挂。带依赖插件请用 registry 包名或 tarball。

## 依赖界限（菲博 §7.1.2）

`playwright-core` 是插件的运行时依赖，**只装进 profile 的 node_modules**——
绝不进入 DeepCode 私有 Runtime / electron 包。浏览器内核复用系统 Edge
（`channel: 'msedge'`），零内核下载、headed 可见、跟随系统更新。

## 安全设计（菲博 §7.1.5）

- **SSRF 先锁后看**：导航目标先过 `validateNavigationTarget`（协议/长度/凭据
  卫生 → DNS 解析 → 全部 IP 校验），浏览器 context 强制走本机 SSRF 代理
  （解析后按 IP 连接 + 重定向逐跳重新校验），DNS 重绑定无法到达内网。
- **权限门控**：L0 只读直放；L1 交互在 read-only 会话拒绝（浏览器交互对外部
  世界有副作用，不因不写工作区豁免）；L2 敏感操作走官方 ApprovalService，
  approval 缺失 fail closed。
- **无 evaluate**：B2/V1 明确不做任意脚本执行（菲博 §7.1.4 裁决）；将来如需，
  走 CDP isolated world + 固定只读 helper 集。
- **Cookie 不持久化**：headed 模式下用户可在可见窗口内人工登录（B2 决策）；
  持久化开关属 B3。

## 开发

```sh
pnpm --dir apps/desktop/browser-plugin install   # 开发依赖（workspace 根已含）
node node_modules/typescript/bin/tsc -b apps/desktop/browser-plugin   # 构建 lib/
pnpm exec vitest run apps/desktop/tests/browser-plugin                # 单测
```

测试位于 `apps/desktop/tests/browser-plugin/`（纳入 `apps/*/tests` 测试面）。
真浏览器冒烟（navigate 公网页 → snapshot a11y 树）属 dev/packaged 双形态 e2e，
需要真实 Edge 与出站网络，由验收方执行。
