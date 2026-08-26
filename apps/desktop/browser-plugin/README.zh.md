# @see-sol-lab/deepcode-browser

[English](README.md) | 中文

DeepCode 浏览器插件通过官方 Harness 工具调用循环，向 agent 暴露可见的 Microsoft Edge 浏览器。它组合只读浏览、交互工具、SSRF 防护、权限分级与敏感动作批准。

## 工具

### 只读（L0）

- `browser_navigate` 在 SSRF 策略允许后打开 URL。本机、内网与保留网段地址都会被拒绝，包括 DeepCode 自己的 loopback 控制服务。
- `browser_snapshot` 返回无障碍树与可见文本，并提供稳定 `ref` 供后续交互。
- `browser_screenshot` 把页面截图保存在本地。模型需要支持视觉才能检查图片本身。
- `browser_wait` 等待 load、network idle、selector 或有上限的延时。
- `browser_tabs` 列出、新建、切换与关闭标签页。

### 交互（L1）

- `browser_click` 与 `browser_hover` 可以使用稳定 `ref`、文本、CSS selector 或 role 与 name 定位。
- `browser_type` 输入文本，并可选择先清空或按下 Enter。
- `browser_scroll` 滚动页面或把元素滚入视野。
- `browser_keyboard` 向浏览器发送受支持的按键。

### 敏感（L2）

- `browser_submit` 只有在官方 Harness ApprovalService 授权后，才会提交表单、发送消息或完成登录动作。批准服务缺失时会快速失败。

交互工具通过 CDP 在浏览器进程内部注入输入。它们绝不移动用户的物理鼠标、通过物理键盘输入，也不会抢占桌面焦点。

Read-only 会话拒绝全部 L1 交互。L2 动作会先通过 read-only 检查，然后要求批准。

## 安装

DeepCode Managed Profile 已包含浏览器 overlay。兼容的自定义 Profile 可以通过官方插件路径安装该包：

```sh
dsh plugin add @see-sol-lab/deepcode-browser

# Development tarball
dsh plugin add ./see-sol-lab-deepcode-browser-0.1.0.tgz
```

该包声明 `dsh.bundle.patch`，因此 `dsh plugin add` 会把 bundle 插入 Profile 组合，不需要人工编辑 patch。

带运行时依赖的插件请使用 registry 包或 tarball。pnpm 不会把本地目录 spec 的传递依赖链接进隔离 Profile 的 `node_modules`。

## 运行时依赖

`playwright-core` 属于 Profile `node_modules` 下的插件运行时闭包，不会加入 DeepCode 私有运行时或 Electron 载荷。插件复用已安装的 Microsoft Edge channel，不下载浏览器内核。

## 安全

- **SSRF 执行：** URL 校验会检查协议、长度、凭据、DNS 结果与每个解析地址。浏览器 context 使用本地代理连接已检查的 IP，并重新校验每次重定向。
- **权限分级：** L0 只读；Read-only 会话拒绝 L1；L2 需要官方 ApprovalService。
- **无任意执行：** V1 不提供页面脚本执行工具。
- **临时 Cookie：** V1 不持久化浏览器 Cookie。用户可以在可见浏览器中完成已批准的登录，但后续浏览器运行不会保留该 Cookie 状态。

## 开发

```sh
pnpm --dir apps/desktop/browser-plugin install
node node_modules/typescript/bin/tsc -b apps/desktop/browser-plugin
pnpm exec vitest run apps/desktop/tests/browser-plugin
```

单元测试位于 `apps/desktop/tests/browser-plugin/`。真实浏览器冒烟测试需要 Microsoft Edge 与出站网络。
