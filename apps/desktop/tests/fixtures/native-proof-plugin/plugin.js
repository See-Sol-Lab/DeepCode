/**
 * DeepCode native-plugin proof fixture: a minimal third-party-style Cordis
 * function plugin. It is NOT a workspace package, production code never
 * imports it, and the packaged runtime never treats it as built-in — it only
 * ever mounts because a test-built profile lists it through a normal
 * cordis.patch.yml insert row and resolves it from the profile-local
 * node_modules. Its only observable effects come from apply(ctx, config):
 * an optional JSON marker (nonce, plugin name, pid, ppid, DSH_HOME), an
 * optional deliberate throw (the negative path), an optional loopback
 * HTTP server (the readiness gate for the controller e2e), and an optional
 * fake-credential echo to stdout/stderr (the packaged log-redaction proof;
 * the value is constructed fake data, never a real secret).
 *
 * CommonJS: the vendored Loader resolves bare third-party names through its
 * require path in both the dev (tsx) and the packaged (ELECTRON_RUN_AS_NODE)
 * runtimes, so the fixture stays loadable everywhere without ESM interop.
 */

const { writeFileSync } = require('node:fs')
const { createServer } = require('node:http')

exports.name = 'deepcode-native-proof-plugin'

exports.apply = function apply(ctx, config = {}) {
  if (config.throw === true) {
    // The web server row may already be listening when this apply runs, so a
    // bare throw leaves a race: readiness probing can catch the short-lived
    // server and the boot then fails at page-load — or even falsely succeeds.
    // Scheduling a hard exit right behind the throw keeps the Cordis
    // apply-throw path exercised while guaranteeing the process dies before
    // it can answer a readiness probe, making the negative path fail
    // deterministically at the readiness stage.
    setImmediate(() => { process.exit(1) })
    throw new Error('deepcode-native-proof-plugin: apply threw on purpose')
  }
  if (typeof config.markerPath === 'string' && config.markerPath.length > 0) {
    writeFileSync(config.markerPath, JSON.stringify({
      nonce: config.nonce,
      plugin: exports.name,
      pid: process.pid,
      ppid: process.ppid,
      dshHome: process.env.DSH_HOME ?? null,
    }))
  }
  if (typeof config.echoFakeSecret === 'string' && config.echoFakeSecret.length > 0) {
    // Split the write so the credential crosses a stream chunk boundary on
    // the consumer side whenever the pipe flushes between the two halves.
    const half = Math.floor(config.echoFakeSecret.length / 2)
    process.stdout.write(`fixture stdout secret: ${config.echoFakeSecret.slice(0, half)}`)
    process.stdout.write(`${config.echoFakeSecret.slice(half)}\n`)
    process.stderr.write(`fixture stderr secret: ${config.echoFakeSecret}\n`)
  }
  if (typeof config.port === 'number') {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok')
    })
    server.listen(config.port, '127.0.0.1')
    ctx.effect(() => () => { server.close() })
  }
}
