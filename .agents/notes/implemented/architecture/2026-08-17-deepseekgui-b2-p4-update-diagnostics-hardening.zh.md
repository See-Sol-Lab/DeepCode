# Agent Note：DeepSeekGUI B2-P4 —— 更新服务、诊断中心、日志保留、发行物加固

状态：已实施

[English](2026-08-17-deepseekgui-b2-p4-update-diagnostics-hardening.md) | 中文

## 问题

桌面端此前没有更新路径（托盘刻意不放置 Check-for-Updates 占位），诊断止步于一对 `current + .old` 日志（下一次普通启动就把 crash 证据顶掉），发行门禁只查身份事实，不查出厂资产、license notices、session log 缺席与产物 digest 清单。repo 私有期间，"检查更新"也一直没有诚实的回答——假装公开 feed 或向用户索取 personal token 从来不可接受。

## 决策

**更新服务——一个 provider、五个组件、只比较 DeepSeekGUI version。** 比较对象只能是 DeepSeekGUI app version（绝不用 embedded DSH version 驱动更新决策）。provider 读取 HTTPS feed manifest，经严格解析（`update-service.ts`：stable `latestVersion`、release notes、资产逐项 HTTPS-only URL + 64 位 hex SHA-256 + 正数 size + 安全文件名——未知字段与目录成分一律拒绝，绝不猜测）。feed 配置在 `userData/deepseekgui-update-feed.json`（`feedUrl`，仅 HTTPS）；缺失/损坏/非 HTTPS = 未配置。Manual Check 对未配置/已是最新/失败都给出明确结果（未配置时显示「当前未配置公开更新通道」）；background check（延迟 8 秒、不阻塞启动）对未配置与网络错误静默，只有 strictly newer stable 才提示——面板状态 + 每版本一次托盘气泡（`isNewerStable`：prerelease 永不提示；semver 比较自包含、零依赖）。下载前必须明确确认，经注入式 HTTP 客户端流式下载（字节上限 + AbortSignal 取消），任何失败清理 partial，SHA-256 验证通过前绝不执行；只抓取配置 manifest 声明的 HTTPS URL（绝不 file://、绝不用户任意路径）。installer handoff 弹「退出 DeepSeekGUI 并开始安装更新？」——先 spawn 已验证 installer（settleSpawn 确认成功），再 orderly 停止 Harness、销毁视图/托盘并退出；spawn 失败保持应用可用、绝不删除当前安装。已验证 installer 采用 single-slot 策略（最多一份；同版本同 digest 复用）。SmartScreen 在 UI 与文档明示；不做假签名验证。

**诊断中心——allowlist 事实、只生成本地 bundle。** chrome 面板显示受控来源组装的 build info（版本四元组、Home kind 不含路径、active Profile、Harness 状态、日志位置、更新通道）+ 打开日志文件夹 / 复制构建信息（main 剪贴板）/ 导出诊断包。bundle 是 `userData/diagnostics/` 下的本地目录（绝不上传）：`bundle-manifest.json` 逐文件列出归一化来源与大小，日志副本再过一遍脱敏，credential/`.env`/session 正文结构性排除（文件名 allowlist：仅 `.log[.N]`、`.txt`、manifest）。用户路径导出前归一化为 `<USER_HOME>`。导出失败绝不删除原日志。

**日志保留——有限轮转，不建第二套日志系统。** `createServiceLogWriter` 在打开时经 `planLogRotation`（纯函数）轮转（启动与 restart 同一策略）：current + 至多 4 份历史 = 共 5 份，另有总大小 budget，最老先删；stat 失败绝不导致误删证据。crash 证据在下一次普通启动时 shift 进历史，绝不被立刻顶掉。无日志数据库、无后台清理。

**发行物完整性。** `build-desktop-dist.ts` 写 `dist/desktop/SHA256SUMS.txt`（installer + 解包 exe 的 digest）；`verify-desktop-dist.ps1` 另加门禁：app.asar 存在（Desktop Chrome 资产出厂）、四份 license notices、载荷内无 `.jsonl`、清单每个 digest 重算并逐一比对。

## 备选方案

- **repo 私有期间用 GitHub Releases 当 feed**：拒绝——未认证 feed 会 404，认证要么打包 token 要么向用户索取，施工单两者都禁止。稳定 provider contract + 配置文件意味着公开后只换配置。
- **electron-updater 等通用更新框架**：拒绝——其 provider 语义（github/generic）与私有 repo 策略对不上，且 handoff 必须走 DeepSeekGUI 自己的 orderly shutdown；自包含 manifest provider 比适配一个框架更小。
- **ZIP 格式诊断包**：v1 拒绝——普通目录 + manifest 已达成"只本地、可列清单、已脱敏"，无需引入归档依赖；将来加 zip 不破坏契约。
- **日志守护进程/数据库**：拒绝——施工单明确不要日志数据库或后台服务；打开时轮转就是全部机制。
- **下载后自动安装**：拒绝——handoff 必须显式确认；取消时应用继续运行、已验证 installer 保留。

## 后果

- 托盘与 chrome 都有真实 Check for Updates 入口；更新面板状态（idle/checking/available/downloading/verified/error）来自 main 的单一 `updateView`，托盘的新版本标签读同一模型。
- 未配置 feed 在所有出口都诚实：Manual 明示、background 静默、绝不索取凭据。
- 诊断包按构造可安全分享（allowlist + 脱敏 + 归一化）；发行门禁在资产/notices 缺失、session log 出厂、任何 digest 不匹配时失败。
- 日志证据跨重启保留且占用有界。

## 验收返工后的事实

第一版只写了文档、返工才真正接线的东西，全部落地：

- **日志轮转最老先执行。** `planLogRotation` 按目标序号降序输出 rename 链（搬进最高空位的文件先动），执行方先 `deletes` 后 `renames`——升序执行会先让 `.1→.2` 压掉原 `.2`，后面的 `.2→.3` 搬的已是覆盖后的文件，历史证据被吃、序号出空洞。单测断言整个数组的精确顺序，六次启动用例逐份核对内容与连续序号。
- **SHA-256 清单共用一套路径约定。** 条目记相对 `dist/desktop` 的正斜杠路径（`win-unpacked/DeepSeekGUI.exe`、`DeepSeekGUI-Setup-….exe`），`verify-desktop-dist.ps1` 换回本机分隔符解析。此前 build 写裸 basename 而 verify 按 `dist\desktop` 解析——门禁挂在自己的清单上，干净 PATH 启动与三件 Runtime 检查整轮没跑到。
- **归一化作用于写盘的字节，不只是 manifest 元数据。** 诊断包内每个文件（build-info、脱敏日志副本、manifest 自身）写入前都过 `normalizeUserPaths(content, home)`——此前只归一化了 manifest 的 `source` 字段，日志路径原样躺在 build-info.txt 里。
- **更新执行面是可测的服务层。** `update-runner.ts` 持有 check/download/handoff，注入 `fetchText`/`downloadAsset`/`spawnInstaller`；manifest 抓取复用 `streamDownload` 的 HTTP 层校验（非 2xx/重定向/大小上限/取消，abort 同时切断 socket）。e2e 里原先挂账的 5 个 `it.todo` 已在对本机 mock HTTP server 的服务层补成真用例（current/newer、下载确认/取消与 partial 清理、digest mismatch、handoff 确认、handoff spawn 失败）。
- **single-slot 真接线。** 下载前清空 `userData/updates/`，`verified.json` 落盘跨重启复用（复用前与安装前都重新验 digest），取消/失败清理 partial。
- **状态语义进模型。** `UpdateView.result` 携带 `unconfigured`/`current`/`error` reason code（文案归 view-model 字典，renderer 不再拿中文字符串相等判状态），`channel` 在构建视图时从 feed 配置现算，dismiss 按钮补 testId，两条取消安装路径（对话框取消与面板取消）统一回到 available 并给同一提示。
- **诊断导出容错且含历史。** 导出全程 try/catch + 明确错误对话框；bundle 复制 current 与全部轮转历史（`.1` …）——crash 证据常在 `.1`。

## 暂缓

- installer 的 Authenticode 验证：等有代码签名证书；本阶段只文档化 SmartScreen 限制，不伪造签名检查。
- 公开 feed 的发布（See-Sol-Lab stable manifest 或公开 GitHub Releases）与切换配置的入口：依赖仓库可见性，不是代码改动。
- 多资产 feed（按平台）：v1 安装第一个资产；manifest schema 已是资产数组，将来按平台选择无需换格式。
- 诊断包 zip 格式与 feed URL 的 UI 编辑（配置入口暂为配置文件）。

## 给验收阶段的验证提示

- 核心测试用本地 mock/fake HTTP（`streamDownload` 的注入面）与 fixture manifest——不访问公网、不碰 GitHub Releases、无凭据。
- 更新 handoff 对话框是主进程 `dialog.showMessageBox`；打包验收驱动安装路径时沿用 P1 的人工 UI 审查模式（installer spawn 本身不进 e2e）。
- feed 的真实 `https.get` 只在 dev 且配置了 feed 时发生；parser/downloader/verifier 逻辑全部用 fake 单测覆盖。
- `verify-desktop-dist.ps1` 注释保持纯 ASCII（PowerShell 5.1 的 ANSI 解码坑已记入房主日志）。
