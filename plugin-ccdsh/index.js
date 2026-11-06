/**
 * cc-dsh host plugin: a small authenticated HTTP gateway that lets a phone
 * (the cc-dsh Android shell, or any browser) drive this DeepSeek Harness.
 *
 * Everything runs in the Harness host process; there is no second service to
 * start. The gateway serves a mobile web UI and a JSON API that calls the
 * Harness services directly (sessionController, agentPresets, ...).
 *
 * Activation is deliberately fail-soft: a Harness update that renames a service
 * must never take the rest of the composition down with it, so nothing here
 * throws out of `apply`. Missing capabilities are reported through `/api/health`
 * and only disable the features that need them.
 */
import { Gateway } from './lib/gateway.js'

export const name = 'cc-dsh'

// The Loader passes the row's raw `config` object; defaults live here so the
// plugin stays usable with an empty row and never depends on a schema runtime.
const DEFAULTS = { port: 7317, host: '0.0.0.0', autoPair: true, discovery: true, allowFirstPair: true }

export function apply(ctx, config = {}) {
  const log = makeLogger(ctx)
  let gateway = null

  try {
    const options = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
    gateway = new Gateway(ctx, {
      port: Number(options.port) || DEFAULTS.port,
      host: String(options.host || DEFAULTS.host),
      autoPair: options.autoPair !== false,
      discovery: options.discovery !== false,
      allowFirstPair: options.allowFirstPair !== false,
      log,
    })
  } catch (error) {
    // Construction touches Harness services; a signature change must degrade,
    // not abort the profile.
    log.error('cc-dsh could not initialise; the harness itself is unaffected:', error?.stack || error)
    return
  }

  try {
    ctx.effect(() => {
      gateway.start().catch((error) => {
        log.error('gateway failed to start:', error?.stack || error)
      })
      return () => gateway.stop()
    })
  } catch (error) {
    log.error('cc-dsh could not register its lifecycle:', error?.stack || error)
  }
}

function makeLogger(ctx) {
  const prefix = '[cc-dsh]'
  const wrap = (fn) => (...args) => {
    try {
      fn(prefix, ...args)
    } catch {
      /* logging must never break the host */
    }
  }
  const versions = process.versions
  return {
    info: wrap(console.log),
    warn: wrap(console.warn),
    error: wrap(console.error),
    runtime: () => ({ electron: versions.electron || null, node: versions.node || null, chrome: versions.chrome || null }),
  }
}
