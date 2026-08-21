/**
 * Boot-free profile inspection entry for `dsh profiles --json`: enumerate the
 * real profiles under the Harness home through the read-only inspection helper
 * and print one JSON document on stdout. Nothing is created, healed, or
 * rewritten; per-profile skipped-patch diagnostics go to stderr only, so
 * stdout carries exactly the JSON document and nothing else.
 * @module @deepseek-ai/dsh/profiles
 */

import { fileURLToPath } from 'node:url'
import { inspectExistingProfiles } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Absolute path of this dsh installation's package.json (both anchors: src/ and lib/ sit one level under apps/cli). */
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/* v8 ignore start -- built-bin acceptance drives this boot-free dispatch */
/**
 * Print the profile discovery document: `schemaVersion`, the resolved
 * DSH_HOME, and one entry per real profile with its static classification.
 */
export function runProfiles(): void {
  const home = resolveDshHome()
  const document = {
    schemaVersion: 1,
    dshHome: home,
    profiles: inspectExistingProfiles('dsh', INSTALL_ANCHOR, home, line => void process.stderr.write(line)),
  }
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`)
}
/* v8 ignore stop */
