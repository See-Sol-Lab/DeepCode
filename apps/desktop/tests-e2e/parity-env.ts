/**
 * Parity 套件的隔离环境（环境变量部分）。注意：Windows 上 Electron 的
 * userData 走 Known Folder API，不跟随 APPDATA 环境变量——userData 的真正
 * 隔离由各 e2e 在启动参数里传 Chromium 标准开关 --user-data-dir 完成；
 * 这里的 APPDATA/LOCALAPPDATA/DSH_HOME 钉扎保留为纵深防御，一切凭据形态
 * 的环境变量（KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL，任意大小写）都不进入
 * 被测进程。
 * @module @see-sol-lab/deepseekgui/tests-e2e/parity-env
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 凭据形态的环境变量名。 */
const CREDENTIAL_NAME = /key|token|secret|password|credential/i

/**
 * 复制环境并剔除一切凭据形态变量。
 * @param env - 源环境。
 * @returns 不含凭据形态变量的副本。
 */
export function scrubCredentialEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !CREDENTIAL_NAME.test(name)) out[name] = value
  }
  return out
}

/**
 * 构造被测 Electron/DSH 进程的完整环境：凭据剔除后，把 APPDATA、
 * LOCALAPPDATA、DSH_HOME 与 USERPROFILE 显式指进测试临时根（目录就地创建）。
 * userData 的隔离不在这里——调用方必须另传 --user-data-dir 启动参数。
 * @param tempRoot - 本次测试的临时根目录。
 * @returns 传给被测进程的环境。
 */
export function parityEnv(tempRoot: string): Record<string, string> {
  const env = scrubCredentialEnv(process.env)
  delete env.DSH_DESKTOP_SMOKE
  delete env.NODE_OPTIONS
  const roaming = join(tempRoot, 'appdata-roaming')
  const local = join(tempRoot, 'appdata-local')
  const dshHome = join(tempRoot, 'dsh-home')
  const profile = join(tempRoot, 'userprofile')
  for (const dir of [roaming, local, dshHome, profile]) mkdirSync(dir, { recursive: true })
  env.APPDATA = roaming
  env.LOCALAPPDATA = local
  // DSH_HOME 对 launcher 已 inert（DSH_HOME 只由 launcher state 的
  // selection 决定），仍把它钉在测试临时根内作为纵深防御：任何未来
  // 仍读取该变量的消费者都不会碰到真实用户目录。
  env.DSH_HOME = dshHome
  // USERPROFILE 是 `os.homedir()` 在 Windows 上的来源，钉住它才算真的隔离：
  // 上面三项挡不住任何走 homedir() 的读取。2026-08-26 实机教训——首启的
  // 「导入已有对话」检测读 `homedir()/.dsh`，于是被测进程直接看进了操作者
  // 真实的用户目录，在那里发现 31 个对话、弹出模态、把整套 e2e 卡死。隔离
  // 一旦漏掉一条路径，测试就不再是在测我们造的环境。
  env.USERPROFILE = profile
  return env
}
