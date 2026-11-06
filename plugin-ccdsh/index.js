/**
 * cc-dsh host plugin: a small authenticated HTTP gateway that lets a phone
 * (the cc-dsh Android shell, or any browser) drive this DeepSeek Harness.
 *
 * Everything runs in the Harness host process; there is no second service to
 * start. The gateway serves a mobile web UI and a JSON API that calls the
 * Harness services directly (sessionController, agentPresets, ...).
 */
import { Gateway } from './lib/gateway.js'

export const name = 'cc-dsh'

// The Loader passes the row's raw `config` object; defaults live here so the
// plugin stays usable with an empty row and never depends on a schema runtime.
const DEFAULTS = { port: 7317, host: '0.0.0.0', autoPair: true, discovery: true, allowFirstPair: true }

export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  const log = makeLogger(ctx)
  const gateway = new Gateway(ctx, {
    port: Number(options.port) || DEFAULTS.port,
    host: String(options.host || DEFAULTS.host),
    autoPair: options.autoPair !== false,
    discovery: options.discovery !== false,
    allowFirstPair: options.allowFirstPair !== false,
    log,
  })

  ctx.effect(() => {
    gateway.start().catch((error) => {
      log.error('gateway failed to start:', error?.stack || error)
    })
    return () => gateway.stop()
  })
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
  return {
    info: wrap(console.log),
    warn: wrap(console.warn),
    error: wrap(console.error),
  }
}
