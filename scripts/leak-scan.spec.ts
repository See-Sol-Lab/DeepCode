/**
 * Leak-scan tests: repository-root sanitization with no size cutoff, `.map`
 * coverage, filename findings, home-path detection, and own-package API-key
 * scoping.
 * @module scripts/leak-scan
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sanitizeAndVerify } from './leak-scan.ts'

const REPO_ROOT = 'C:\\build\\deepseek-harness'
const HOME = 'C:\\Users\\builder'

let temp: string | undefined

function dist(): string {
  temp = mkdtempSync(join(tmpdir(), 'leak-scan-'))
  return temp
}

afterEach(() => {
  if (temp !== undefined) rmSync(temp, { recursive: true, force: true })
  temp = undefined
})

describe('sanitizeAndVerify', () => {
  it('净化超过 512KB 的大文本文件（无大小上限）', () => {
    const root = dist()
    const big = join(root, 'resources', 'dsh', 'node_modules', '@deepseek-ai', 'x', 'lib')
    mkdirSync(big, { recursive: true })
    const path = join(big, 'client.js')
    writeFileSync(path, `${'a'.repeat(600 * 1024)}\nurl("${REPO_ROOT.replaceAll('\\', '/')}/style.css")\n`)
    const findings = sanitizeAndVerify(root, REPO_ROOT, HOME)
    expect(findings).toEqual([])
    expect(readFileSync(path, 'utf8')).toContain('<dsh-root>')
    expect(readFileSync(path, 'utf8')).not.toContain('deepseek-harness')
  })

  it('.map 文件按文本净化与扫描', () => {
    const root = dist()
    mkdirSync(join(root, 'lib'), { recursive: true })
    const path = join(root, 'lib', 'index.js.map')
    writeFileSync(path, `{"sources":["${REPO_ROOT.replaceAll('\\', '\\\\')}\\\\src\\\\index.ts"]}`)
    sanitizeAndVerify(root, REPO_ROOT, HOME)
    expect(readFileSync(path, 'utf8')).toContain('<dsh-root>')
  })

  it('.package-lock.json 本身就是 finding（npm 以相对 file: URL 记录构建机路径）', () => {
    const root = dist()
    mkdirSync(join(root, 'resources', 'dsh', 'node_modules'), { recursive: true })
    writeFileSync(
      join(root, 'resources', 'dsh', 'node_modules', '.package-lock.json'),
      '{"packages":{"a":{"resolved":"file:../../../../../builder/Desktop/deepseek-harness/dist/npm-dsh/a.tgz"}}}',
    )
    const findings = sanitizeAndVerify(root, REPO_ROOT, HOME)
    expect(findings.some(f => f.startsWith('npm install lockfile:'))).toBe(true)
  })

  it('报告 .git、.env 与会话日志文件名', () => {
    const root = dist()
    mkdirSync(join(root, 'resources', '.git'), { recursive: true })
    writeFileSync(join(root, 'resources', '.git', 'config'), '')
    writeFileSync(join(root, '.env.local'), 'DEEPSEEK_API_KEY=nope')
    writeFileSync(join(root, 'session.jsonl'), '{}')
    const findings = sanitizeAndVerify(root, REPO_ROOT, HOME)
    expect(findings.some(f => f.startsWith('VCS metadata:'))).toBe(true)
    expect(findings.some(f => f.startsWith('env file:'))).toBe(true)
    expect(findings.some(f => f.startsWith('session log:'))).toBe(true)
  })

  it('报告用户主目录路径；API key 只在本仓库产物内报告', () => {
    const root = dist()
    const own = join(root, 'resources', 'dsh', 'node_modules', '@deepseek-ai', 'x')
    const foreign = join(root, 'resources', 'dsh', 'node_modules', 'upstream')
    mkdirSync(own, { recursive: true })
    mkdirSync(foreign, { recursive: true })
    writeFileSync(join(own, 'a.js'), `const key = 'sk-${'a'.repeat(30)}'`)
    writeFileSync(join(foreign, 'docs.md'), `example: sk-${'b'.repeat(30)}; path ${HOME}\\secret`)
    const findings = sanitizeAndVerify(root, REPO_ROOT, HOME)
    expect(findings.some(f => f.startsWith('possible API key:') && f.includes('@deepseek-ai/x'))).toBe(true)
    expect(findings.some(f => f.startsWith('possible API key:') && f.includes('upstream'))).toBe(false)
    expect(findings.some(f => f.startsWith('user path:') && f.includes('upstream'))).toBe(true)
  })

  it('builder-debug.yml 本身就是 finding（NSIS 命令行含构建机路径）', () => {
    const root = dist()
    writeFileSync(join(root, 'builder-debug.yml'), 'nsis: []')
    const findings = sanitizeAndVerify(root, REPO_ROOT, HOME)
    expect(findings.some(f => f.startsWith('build metadata:'))).toBe(true)
  })

  it('只扫不改写模式：仓库根路径报为 finding 且文件不被修改', () => {
    const root = dist()
    mkdirSync(join(root, 'lib'), { recursive: true })
    const path = join(root, 'lib', 'latest.yml')
    const original = `path: ${REPO_ROOT}\\dist\\x.exe`
    writeFileSync(path, original)
    const findings = sanitizeAndVerify(root, REPO_ROOT, HOME, { rewrite: false })
    expect(findings.some(f => f.startsWith('repo path:') && f.includes('latest.yml'))).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  it('干净目录返回空 findings', () => {
    const root = dist()
    mkdirSync(join(root, 'lib'), { recursive: true })
    writeFileSync(join(root, 'lib', 'main.js'), 'console.log(1)')
    expect(sanitizeAndVerify(root, REPO_ROOT, HOME)).toEqual([])
  })
})
