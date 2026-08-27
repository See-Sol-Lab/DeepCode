# Agent Note: Runtime closure and Windows x64 volume optimization

Status: proposed

English | [中文](2026-08-15-desktop-runtime-closure-and-volume.zh.md)

## Problem

The [portable distribution](2026-08-16-desktop-portable-distribution.md) shipped every packed tarball of both release families as direct staging dependencies, so npm could not tell the Web profile's real runtime from the repository's other capabilities, build tools, and test tooling. The measured win-unpacked payload was ~950MB, of which `resources/dsh` was ~603MB: `@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` alone was ~253MB, plus node-pty ~63MB, typescript ~23MB, rolldown ~20MB, sharp ~18MB, esbuild ~11MB, and test dependencies.

## Proposal

**Closure computation (`scripts/runtime-closure.ts`).** The staging consumer's `file:` dependencies are now exactly the production runtime closure: every local tarball reachable from the packages the shipped Web profile mounts, walking `dependencies`, `optionalDependencies`, and `peerDependencies` (npm 7+ auto-installs required peers, so local peers such as `dsh-workflow` for the worker-thread provider must ship; optional peers marked in `peerDependenciesMeta` are not auto-installed by npm, but the closure walks them deliberately — a closed distribution cannot install one later, and mounted plugins use an optional peer when present). Roots come from the `name:` rows of `packages/bundle/base/cordis.patch.yml`, `packages/bundle/web-app/cordis.patch.yml`, and every agent preset shipped inside the `@deepseek-ai/dsh` tarball (its `files` list carries the whole `config` directory and the preset picker lets a session mount any of them), plus the launcher itself (`@deepseek-ai/dsh`) and the frontend package the web-app bundle resolves dynamically (`@deepseek-ai/dsh-web-frontend`, `require.resolve` of the built dist — invisible to static edges). The vendored Cordis family is included wholesale as the framework layer. The build prints total/included/excluded tarball counts and the roots. A missing local runtime dependency fails the build loudly — a missing root and a recursively reached `@deepseek-ai/*` dependency whose tarball was not packed both throw, instead of letting npm resolve the name against the public registry; the named exception is the Landlock launcher (`@deepseek-ai/node-addon-landlock-run`), which its own release family publishes to the registry (native/README.md) and the staging install deliberately resolves from there.

**Windows x64 platform pruning (`scripts/platform-prune.ts`).** Two facts drive the rules: node-pty's multi-platform prebuilds (darwin-arm64/darwin-x64/win32-arm64/win32-x64) can only ever load `win32-x64` on this product, and `*.pdb` debug symbols are never loaded. Each rule is a small tested function; there is no post-build `rm` list.

**Why the remaining large dependencies stay.** `@opentelemetry/*` (telemetry seam, mounted), `@img/sharp` (attachment image processing, mounted `attachment-local`), `@google/genai`, `@mistralai`, `openai` (the mounted `llm-pi-ai` provider's model backends), `@shikijs`/`@vscode`/`@mixmark-io` (Web UI markdown rendering), `node-pty` (the mounted subprocess provider's PTY backend) — all sit on real mounted-plugin dependency chains. Nothing is deleted by name alone; an Anthropic/OpenAI/Google package stays only when its owning plugin is actually mounted.

## Alternatives considered

**Ship a hand-written "safe to delete" package list.** Rejected: the milestone requires a verifiable closure, not an opinionated list; the closure is computed from tarball manifests and profile compositions.

**Reinstall all tarballs as the fallback when a dynamic reference is found.** Rejected: the dynamic references found during the investigation (workflow/code-runtime/telemetry peers) were resolved by adding peer edges to the closure, which is their true ownership.

**Skip platform pruning.** Rejected: node-pty's other-platform prebuilds are ~58MB of payload that can never load on Windows x64.

## Verification

Optimized runtime ~190MB (was ~603MB); full win-unpacked below 600MB; NSIS installer materially smaller. The packaged app keeps: no external Node/pnpm/npm/Git/source, clean-PATH startup, official UI load, Models/workspace/session surfaces, app-scoped `%APPDATA%\DeepSeekGUI\dsh`, no EPIPE regression, port release on close, zero leftover processes, per-user NSIS install with shortcuts and uninstall, sanitize-before-package, and no key/session/.env/.git/username/private-path leaks.

## Acceptance criteria

- Closure unit tests cover recursive production deps, optional deps, peer deps, devDependency exclusion, dynamic Web-profile seeds, and loud failure on missing local runtime deps; platform-prune tests pin the two rules.
- `pnpm run build:desktop-dist` produces the optimized win-unpacked and installer in one run.
- All prior stage gates stay green (desktop 20 tests, build:desktop, typecheck, doc checks, verify-desktop-dist.ps1, git diff --check).

## Risks

- An unlisted dynamic reference would surface as a startup failure; the packaged smoke is the final guard.
- Volume targets are indicative; if the closure cannot reach them, the report lists the top-20 remaining directories with their real dependency chains instead of blind deletion.
