/**
 * DeepSeekGUI 品牌化的 web 前端构建（P8-D34）。
 *
 * 官方侧栏品牌区在非 official 构建里显示「DSH Local Build + commit hash」
 * fallback；该 fallback 支持 DSH_CLIENT_BRAND_NAME / _BADGE 构建期注入
 * （与所有 DSH_CLIENT_* 值一样由 Vite define 内联）。DeepSeekGUI 的发行构建
 * 固定显示「DeepSeek Harness」＋「local」徽标——表意"基于 DSH 的本地
 * 发行"，与官方发布版和裸本地构建都区分开（住户 2026-08-23 定）。
 *
 * 独立成脚本而不是在 npm script 里 set 环境变量：Windows cmd 的 set 语法
 * 带尾随空格陷阱且不可追溯，这里的五行 spawn 是可读的事实记录。
 * @module scripts/build-web-branded
 */

import { spawnSync } from 'node:child_process'

const brandEnvironment = {
  ...process.env,
  DSH_CLIENT_BRAND_NAME: 'DeepSeek Harness',
  DSH_CLIENT_BRAND_BADGE: 'local',
  // 浏览器标签页标题一并对齐（机制早已存在，官方 official 构建也这么用）。
  DSH_CLIENT_TITLE: 'DeepSeekGUI',
}

// 品牌串在 **build:lib:client（tsdown）阶段**就被内联进各 client 插件的
// lib/client.js（插件运行时经 __ModuleLoader__ 单独加载，不进 vite bundle）
// ——只给 build:web 带环境是不够的：谁裸跑一次 build:lib，品牌就悄悄退回
// 「DSH Local Build」（2026-08-23 实机踩过）。所以 client lib 也在这里带
// 环境重建一遍；跟在无环境 build:lib 之后会重复一次 client lib 构建（约
// 两分钟），用这点时间换「品牌不可能悄悄丢」。
for (const step of ['build:lib:client', 'build:web']) {
  const result = spawnSync('pnpm', ['run', step], {
    stdio: 'inherit',
    shell: true,
    env: brandEnvironment,
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
process.exit(0)
