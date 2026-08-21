/**
 * dsh.cmd 的 argv 级 Profile 默认 wrapper（静态 CJS，dev/packaged 同一
 * 文件，不经 tsc）：用户显式传 --profile 时显式值永远优先；bare 启动/
 * 维护命令默认 target active Profile；help/version 原样透传（不注入）。
 * 结构化扫描 argv 数组——绝不字符串 replace、绝不 shell parsing。
 * 事实全部经 env 由 DeepCode 注入（exact executable 与入口），本文件
 * 不下载 Runtime、不猜测系统安装。
 *
 * 这里是 argv 规则的**唯一实现**：terminal-service.ts 曾另有一份 TS 镜像，
 * 但真正执行的始终是本文件——两份规则只要有一处改动就会静默漂移，所以
 * 镜像已删除，terminal-service.spec 直接测本文件导出的纯函数。
 */
'use strict'

const { spawnSync } = require('node:child_process')

function fail(message) {
  process.stderr.write(`[deepcode dsh wrapper] ${message}\n`)
  process.exit(1)
}

function hasExplicitProfile(tokens) {
  return tokens.some((token, index) =>
    (token === '--profile' && index + 1 < tokens.length)
    || (typeof token === 'string' && token.startsWith('--profile=') && token.length > '--profile='.length))
}

function helpOrVersion(tokens) {
  return tokens.some((argument) =>
    argument === '-h' || argument === '--help' || argument === '-V' || argument === '--version')
}

// 与官方 CLI grammar 严格对齐（apps/cli/src/args.ts）：父级 --profile 只被
// 裸启动接受；plugin 用自己的 requiredOption；profiles/web 等子命令拒绝
// 父级 --profile——对子命令注入会打坏 `dsh profiles --json`。
function resolveProfileArgv(tokens, active) {
  if (helpOrVersion(tokens)) return tokens
  if (tokens.length === 0 || (tokens[0] !== undefined && tokens[0].startsWith('-'))) {
    if (hasExplicitProfile(tokens)) return tokens
    return ['--profile', active, ...tokens]
  }
  if (tokens[0] === 'plugin') {
    if (hasExplicitProfile(tokens)) return tokens
    return ['plugin', '--profile', active, ...tokens.slice(1)]
  }
  return tokens
}

module.exports = { resolveProfileArgv, hasExplicitProfile, helpOrVersion }

// 作为 shim 入口运行时才真正转发（被 require 时只暴露纯函数，便于测试
// 直接测这一份规则，不再维护第二份镜像）。
if (require.main === module) {
  const exe = process.env.DEEPCODE_WRAPPER_EXE
  const dshBin = process.env.DEEPCODE_WRAPPER_DSH_BIN
  const nodeArgsRaw = process.env.DEEPCODE_WRAPPER_NODE_ARGS
  const activeProfile = process.env.DEEPCODE_ACTIVE_PROFILE
  if (typeof exe !== 'string' || exe === '') fail('missing DEEPCODE_WRAPPER_EXE')
  if (typeof dshBin !== 'string' || dshBin === '') fail('missing DEEPCODE_WRAPPER_DSH_BIN')
  if (typeof activeProfile !== 'string' || activeProfile === '') fail('missing DEEPCODE_ACTIVE_PROFILE')

  let nodeArgs = []
  if (nodeArgsRaw !== undefined && nodeArgsRaw !== '') {
    try {
      nodeArgs = JSON.parse(nodeArgsRaw)
      if (!Array.isArray(nodeArgs) || nodeArgs.some((entry) => typeof entry !== 'string')) {
        fail('DEEPCODE_WRAPPER_NODE_ARGS must be a JSON string array')
      }
    } catch {
      fail('DEEPCODE_WRAPPER_NODE_ARGS is not valid JSON')
    }
  }

  const finalArgs = resolveProfileArgv(process.argv.slice(2), activeProfile)
  const result = spawnSync(exe, [...nodeArgs, dshBin, ...finalArgs], {
    stdio: 'inherit',
    env: process.env,
  })
  process.exit(result.status === null ? 1 : result.status)
}
