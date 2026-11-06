import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STATE_VERSION = 1
const CODE_TTL_MS = 10 * 60 * 1000
/** Persist `lastSeenAt` at most this often per device (never on every request). */
const SEEN_PERSIST_MS = 5 * 60 * 1000
/** Coalesce bursts of durable writes into one file replacement. */
const SAVE_DEBOUNCE_MS = 1500

function stateDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'cc-dsh')
}

function stateFile() {
  return path.join(stateDir(), 'state.json')
}

export function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex')
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url')
}

function newPairCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && parsed.version === STATE_VERSION && Array.isArray(parsed.devices)) return parsed
  } catch {
    /* missing or unreadable */
  }
  return null
}

/**
 * Durable gateway state: identity and paired devices.
 *
 * The pairing code is deliberately memory-only: rotating it must never touch
 * the file that holds the device tokens, and every authenticated request used
 * to rewrite that file. Writes are now limited to real changes (pair, revoke,
 * rename, name) plus a throttled `lastSeenAt` flush.
 */
export class GatewayState {
  constructor(log) {
    this.log = log
    this.data = this.#load()
    // The pairing code is memory-only; drop any copy left by older versions.
    delete this.data.code
    this.code = null
    this.saveTimer = null
    this.authFailures = 0
  }

  #load() {
    const primary = readJson(stateFile())
    if (primary) return primary
    const backup = readJson(`${stateFile()}.bak`)
    if (backup) {
      this.log?.warn('state.json unreadable — restored the last backup')
      return backup
    }
    return {
      version: STATE_VERSION,
      serverId: crypto.randomUUID(),
      name: `${os.hostname() || 'DSH'} 的电脑`,
      devices: [],
      code: null,
    }
  }

  /** Debounced durable write, coalescing bursts into one atomic replace. */
  #saveSoon() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.#save()
    }, SAVE_DEBOUNCE_MS)
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref()
  }

  #save() {
    try {
      fs.mkdirSync(stateDir(), { recursive: true })
      const target = stateFile()
      const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      try {
        fs.copyFileSync(target, `${target}.bak`)
      } catch {
        /* first write */
      }
      fs.renameSync(tmp, target)
    } catch (error) {
      this.log?.warn('cannot persist state:', error?.message || error)
    }
  }

  get serverId() {
    return this.data.serverId
  }

  get name() {
    return this.data.name
  }

  set name(value) {
    this.data.name = String(value || '').slice(0, 60) || this.data.name
    this.#saveSoon()
  }

  devices() {
    return this.data.devices.map((device) => ({
      id: device.id,
      name: device.name,
      platform: device.platform || '',
      userAgent: device.userAgent || '',
      createdAt: device.createdAt || 0,
      lastSeenAt: device.lastSeenAt || 0,
    }))
  }

  /** Debug/self-check view; never includes token hashes. */
  snapshot() {
    return {
      serverId: this.data.serverId,
      name: this.data.name,
      devices: this.devices(),
      codeExpiresAt: this.code?.expiresAt || 0,
      codePersisted: Boolean(this.data.code),
      authFailures: this.authFailures,
      file: stateFile(),
    }
  }

  /** Current pairing code, rotated in memory only. */
  pairCode() {
    const now = Date.now()
    if (!this.code || this.code.expiresAt <= now) {
      this.code = { value: newPairCode(), expiresAt: now + CODE_TTL_MS }
    }
    return { value: this.code.value, expiresAt: this.code.expiresAt }
  }

  rotateCode() {
    this.code = { value: newPairCode(), expiresAt: Date.now() + CODE_TTL_MS }
    return { ...this.code }
  }

  /** A readable, unique display name for a newly paired device. */
  #uniqueName(desired) {
    const base = String(desired || '手机').trim().slice(0, 40) || '手机'
    const taken = new Set(this.data.devices.map((device) => device.name))
    if (!taken.has(base)) return base
    for (let index = 2; index < 100; index += 1) {
      const candidate = `${base} (${index})`
      if (!taken.has(candidate)) return candidate
    }
    return `${base} ${crypto.randomBytes(2).toString('hex')}`
  }

  /** Exchange a pairing code for a durable device token. */
  pair(code, deviceName, options = {}) {
    const nothingPairedYet = this.data.devices.length === 0
    const trustedFirstPair = nothingPairedYet && options.allowFirstPair === true

    if (!trustedFirstPair) {
      const current = this.pairCode()
      const expected = Buffer.from(current.value)
      const given = Buffer.from(String(code ?? '').trim())
      if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
        return { ok: false, reason: 'code-invalid' }
      }
    }

    const token = newToken()
    const device = {
      id: crypto.randomUUID(),
      name: this.#uniqueName(deviceName),
      tokenHash: hashCode(token),
      platform: String(options.platform || '').slice(0, 60),
      userAgent: String(options.userAgent || '').slice(0, 200),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      seenPersistedAt: Date.now(),
    }
    this.data.devices.push(device)
    // A pairing code is single use.
    this.rotateCode()
    this.#save()
    return { ok: true, token, deviceId: device.id, deviceName: device.name, serverName: this.name }
  }

  authenticate(token) {
    if (!token) {
      this.authFailures += 1
      return null
    }
    const hash = hashCode(token)
    const device = this.data.devices.find((entry) => entry.tokenHash === hash)
    if (!device) {
      this.authFailures += 1
      return null
    }
    const now = Date.now()
    device.lastSeenAt = now
    // Persisting on every request is what used to clobber the device list; a
    // throttled flush keeps `lastSeenAt` useful without that risk.
    if (now - (device.seenPersistedAt || 0) > SEEN_PERSIST_MS) {
      device.seenPersistedAt = now
      this.#saveSoon()
    }
    return device
  }

  rename(deviceId, name) {
    const device = this.data.devices.find((entry) => entry.id === deviceId)
    if (!device) return false
    const next = String(name || '').trim().slice(0, 40)
    if (!next) return false
    device.name = next
    this.#save()
    return true
  }

  revoke(deviceId) {
    const before = this.data.devices.length
    this.data.devices = this.data.devices.filter((entry) => entry.id !== deviceId)
    if (this.data.devices.length === before) return false
    this.#save()
    return true
  }
}
