// Security primitives for photovirtu rooms.
// Invite codes are high-entropy, never stored in plaintext, and never
// enumerable by clients. Tokens are constant-time compared.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { ALLOWED_ORIGINS, TRUST_PROXY } from './config.js'

// Crockford-style base32 without look-alike characters (no I, L, O, U).
// 32 symbols ^ 8 chars is ~1.1e12 space, unguessable by brute force online.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 8

export function generateInviteCode() {
  const bytes = randomBytes(CODE_LENGTH)
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}

// Normalise before hashing so "virtu-8", "virtu8" and "VIRTU8" are the same room.
export function normaliseCode(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

// We only keep a SHA-256 digest of the invite code in memory.
// A memory dump or log leak does not hand out live room access.
export function hashCode(raw) {
  return createHash('sha256').update(normaliseCode(raw)).digest('hex')
}

export function newPeerId() {
  return randomUUID()
}

// Host/moderator capability token. Separate from the invite code so that
// sharing a room does not also share admin rights.
export function newHostToken() {
  return randomBytes(32).toString('base64url')
}

export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8')
  const bufB = Buffer.from(String(b ?? ''), 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

// Token-bucket rate limiter keyed by IP. Used for join attempts so invite
// codes cannot be probed, and for message floods.
export function createRateLimiter({ capacity, refillPerSecond, idleMs = 10 * 60 * 1000 }) {
  const buckets = new Map()
  const take = (key, cost = 1) => {
    const now = Date.now()
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { tokens: capacity, updated: now }
      buckets.set(key, bucket)
    }
    const elapsed = (now - bucket.updated) / 1000
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSecond)
    bucket.updated = now
    if (bucket.tokens < cost) return false
    bucket.tokens -= cost
    return true
  }
  // Drop idle keys so long-running processes do not grow without bound.
  take.sweep = () => {
    const cutoff = Date.now() - idleMs
    for (const [key, bucket] of buckets) if (bucket.updated < cutoff) buckets.delete(key)
  }
  return take
}

export const constants = { ALPHABET, CODE_LENGTH }

// ---------------------------------------------------------------------------
// HTTP origin + client address handling. Shared by the Express middleware and
// the WebSocket upgrade path so both apply exactly one policy.
// ---------------------------------------------------------------------------
export function clientIp(req) {
  // Upgrade requests bypass Express routing, so req.ip is not populated there.
  // Only trust a proxy-supplied address when deployment opts in explicitly.
  if (TRUST_PROXY) {
    // Cloudflare Tunnel puts the real visitor IP here; prefer it so per-IP
    // limits are per-visitor, not shared across everyone behind the tunnel.
    const cf = req.headers['cf-connecting-ip']
    if (typeof cf === 'string' && cf.length) return cf.trim()
    const forwarded = req.headers['x-forwarded-for']
    if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim()
  }
  return req.socket.remoteAddress ?? 'unknown'
}

export function isAllowedOrigin(origin, host = '') {
  if (!origin) return false
  if (ALLOWED_ORIGINS.includes(origin)) return true
  try {
    // A combined app/API deployment must always accept its own browser origin.
    // Host equality is sufficient here: the browser controls Origin and sends
    // Host for the actual target; TLS downgrade is separately blocked at edge.
    return Boolean(host) && new URL(origin).host === host
  } catch {
    return false
  }
}

export function corsHeaders(origin, host = '') {
  const allowed = isAllowedOrigin(origin, host)
  return {
    allowed,
    headers: {
      'Access-Control-Allow-Origin': allowed ? origin : 'null',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, x-order-token',
      'Access-Control-Allow-Credentials': 'true',
      Vary: 'Origin',
    },
  }
}
