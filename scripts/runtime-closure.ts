/**
 * Runtime closure computation for the DeepSeekGUI distribution.
 *
 * The distribution used to install every packed tarball of both release
 * families as direct staging dependencies, which dragged test toolchains
 * (vitest → vite → rolldown, @testing-library) and unused product backends
 * (subagent-claude-code → @anthropic-ai) into the shipped runtime. The real
 * closure starts from the packages the shipped Web profile actually mounts —
 * the `name` rows of the base and web-app bundle patches plus the default
 * agent preset's composition — and walks production dependency edges
 * (dependencies + optionalDependencies) inside the local tarball set.
 * @module scripts/runtime-closure
 */

/** One local tarball's manifest, restricted to the sections the closure reads. */
export interface TarballManifest {
  /** Package name. */
  name: string
  /** Production dependency declarations. */
  dependencies?: Record<string, string>
  /** Optional dependency declarations (installed when resolvable). */
  optionalDependencies?: Record<string, string>
  /** Peer dependency declarations (npm 7+ auto-installs peers; the host must provide local ones). */
  peerDependencies?: Record<string, string>
}

/** The closure result: which local tarballs ship, which stay out. */
export interface RuntimeClosure {
  /** Local tarballs reachable from the roots, sorted. */
  included: string[]
  /** Local tarballs not reachable, sorted. */
  excluded: string[]
}

/**
 * Compute the production runtime closure over local tarballs.
 * @param manifests - every local tarball manifest by package name.
 * @param roots - packages the shipped profile mounts or otherwise requires.
 * @param registryExternal - scoped package names another release pipeline
 * publishes to the npm registry (e.g. the Landlock launcher family from
 * `native/`); the staging install resolves them from the registry, so their
 * absence from the tarballs is not a packing failure.
 * @returns The included and excluded package names.
 */
/**
 * The repository's package scope. Every package of both release families —
 * including the rescoped vendored Cordis — lives under this scope, so a scoped
 * dependency name absent from the tarball set is a packing failure unless it
 * is one of the named packages another release pipeline publishes to the npm
 * registry (`registryExternal`).
 */
const LOCAL_SCOPE = '@deepseek-ai/'

export function computeRuntimeClosure(
  manifests: ReadonlyMap<string, TarballManifest>,
  roots: readonly string[],
  registryExternal: ReadonlySet<string> = new Set(),
): RuntimeClosure {
  const missing = roots.filter(root => !manifests.has(root))
  if (missing.length > 0) {
    throw new Error(`runtime closure: shipped profile requires local packages absent from the tarballs: ${missing.join(', ')}`)
  }
  const included = new Set<string>()
  const missingLocal = new Set<string>()
  const queue = [...roots]
  while (queue.length > 0) {
    const name = queue.pop()
    if (name === undefined || included.has(name)) continue
    included.add(name)
    const manifest = manifests.get(name)
    if (manifest === undefined) continue
    // Peers are runtime edges here: npm 7+ auto-installs required peer
    // dependencies, so a local peer (e.g. dsh-workflow for the worker-thread
    // provider) must ship in the closure or the installed tree cannot resolve
    // it. Optional peers (`peerDependenciesMeta.optional`) are NOT
    // auto-installed by npm; the closure still walks them deliberately — a
    // closed distribution cannot install one later, and the mounted plugins
    // use an optional peer when it is present.
    for (const section of [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]) {
      if (section === undefined) continue
      for (const dependency of Object.keys(section)) {
        if (manifests.has(dependency)) {
          if (!included.has(dependency)) queue.push(dependency)
        } else if (dependency.startsWith(LOCAL_SCOPE) && !registryExternal.has(dependency)) {
          // A local package reachable from the profile but missing from the
          // packed tarballs: fail loud instead of letting npm resolve the name
          // against the public registry (404 today; a silently wrong published
          // version once the packages go public).
          missingLocal.add(`${dependency} (required by ${name})`)
        }
      }
    }
  }
  if (missingLocal.size > 0) {
    throw new Error(`runtime closure: local runtime dependencies absent from the tarballs: ${[...missingLocal].sort().join(', ')}`)
  }
  const excluded = [...manifests.keys()].filter(name => !included.has(name)).sort()
  return { included: [...included].sort(), excluded }
}

/**
 * Collect every `name:` package reference from a Cordis composition document
 * (bundle patches and agent-preset compositions). Documents use the `!!js`
 * YAML tag, which plain parsers reject, so the extraction is a regex over the
 * canonical single-quoted row form — every shipped composition writes
 * `name: '@deepseek-ai/<pkg>'` or `name: '@deepseek-ai/<pkg>/<subpath>'`.
 * Only `@deepseek-ai/` names are returned; the `cordis:group` pseudo-name is
 * not a package, and subpath references reduce to their owning package.
 * @param yamlText - the composition document.
 * @returns Every package name the document mounts, deduplicated.
 */
export function parsePluginNames(yamlText: string): string[] {
  const names = new Set<string>()
  const pattern = /name:\s*'(@deepseek-ai\/[^']+)'/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(yamlText)) !== null) {
    if (match[1] === undefined) continue
    // `@deepseek-ai/<pkg>/<subpath>` → owning package.
    const [scope, pkg] = match[1].split('/')
    if (scope !== undefined && pkg !== undefined) names.add(`${scope}/${pkg}`)
  }
  return [...names]
}
