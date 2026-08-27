/**
 * English failure-copy coverage: every runtime Han literal in the localized
 * desktop modules stays behind an explicit zh branch, and representative
 * public entry points return Han-free English diagnostics.
 * @module @see-sol-lab/deepseekgui/tests/english-errors
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { DesktopCommandBusyError } from '../src/desktop-command.ts'
import { foldDesktopEvent, renderDesktopEvent } from '../src/desktop-events.ts'
import { buildIssueBody, issueTitle } from '../src/feedback-issue.ts'
import { createHarnessApi } from '../src/harness-api.ts'
import { parseLauncherState } from '../src/launcher-state.ts'
import { parseProfileDiscovery } from '../src/profile-discovery.ts'
import { parseUiState } from '../src/ui-state.ts'
import { runUpdateDownload } from '../src/update-runner.ts'
import { parseUpdateManifest, resolveRedirectTarget } from '../src/update-service.ts'
import { readManifestVersion } from '../src/version-info.ts'

const HAN = /[\u3400-\u9fff]/u

const LOCALIZED_MODULES = [
  'update-service.ts',
  'profile-discovery.ts',
  'harness-controller.ts',
  'harness-api.ts',
  'launcher-state.ts',
  'ui-state.ts',
  'desktop-command.ts',
  'desktop-events.ts',
  'version-info.ts',
  'update-runner.ts',
  'control-dispatch.ts',
  'dsh-service.ts',
  'feedback-issue.ts',
] as const

function messageOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return String(error instanceof Error ? error.message : error)
  }
  throw new Error('Expected the operation to fail')
}

function guardedByZh(node: ts.Node, source: ts.SourceFile): boolean {
  for (let current = node.parent; current !== undefined && current !== source; current = current.parent) {
    if (ts.isConditionalExpression(current) && /zh/i.test(current.condition.getText(source))) return true
    if (ts.isIfStatement(current) && /zh/i.test(current.expression.getText(source))) return true
  }
  return false
}

describe('English desktop failure copy', () => {
  it('keeps every runtime Han literal behind an explicit zh branch', () => {
    const unguarded: string[] = []
    for (const name of LOCALIZED_MODULES) {
      const path = join(process.cwd(), 'apps', 'desktop', 'src', name)
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node): void => {
        const isRuntimeText = ts.isStringLiteral(node)
          || ts.isNoSubstitutionTemplateLiteral(node)
          || ts.isTemplateExpression(node)
          || ts.isRegularExpressionLiteral(node)
        if (isRuntimeText && HAN.test(node.getText(source)) && !guardedByZh(node, source)) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source))
          unguarded.push(`${name}:${String(position.line + 1)}`)
        }
        if (!ts.isTemplateExpression(node)) ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(unguarded).toEqual([])
  })

  it('returns Han-free English from representative public failure paths', async () => {
    const messages = [
      messageOf(() => parseUpdateManifest('{', false)),
      messageOf(() => resolveRedirectTarget('https://example.com/a', undefined, false)),
      messageOf(() => parseProfileDiscovery('[]', false)),
      messageOf(() => parseLauncherState('[]', false)),
      messageOf(() => parseUiState('[]', false)),
      messageOf(() => { throw new DesktopCommandBusyError('maintenance', false) }),
      messageOf(() => readManifestVersion('Z:\\missing\\package.json', 'test manifest', false)),
    ]

    const api = createHarnessApi({
      baseUrl: 'http://127.0.0.1:3080',
      fetch: async () => ({ ok: true, status: 200, json: async () => [] }),
      zh: () => false,
    })
    try {
      await api.settingsDescribe()
    } catch (error) {
      messages.push(String(error instanceof Error ? error.message : error))
    }

    const download = await runUpdateDownload(
      {
        fetchText: async () => '',
        downloadAsset: async () => ({ bytes: 0, sha256: '' }),
        spawnInstaller: async () => {},
      },
      { latestVersion: '1.0.1', releaseNotes: '', assets: [] },
      'unused.exe',
      new AbortController().signal,
      () => {},
      false,
    )
    if (download.kind === 'failed') messages.push(download.message)

    const event = renderDesktopEvent({
      at: '2026-08-27 02:00',
      title: 'Update failed',
      sections: [['Cause', 'The server was unavailable.']],
    }, false)
    messages.push(foldDesktopEvent('', event, 1024, false))
    messages.push(issueTitle('**Title:** Update check failed', 'fallback', false))
    messages.push(buildIssueBody({
      zh: false,
      appVersion: '1.0.0',
      dshVersion: '0.1.1-rc.2',
      windowsVersion: 'Windows 11',
      homeKind: 'managed',
      userText: 'Update check failed.',
      reply: '**Title:** Update check failed',
      diagnostics: 'No secrets.',
    }))

    expect(messages).not.toEqual([])
    for (const message of messages) expect(message).not.toMatch(HAN)
  })
})
