// Every environment read lives here, so the rest of the server works with
// plain values instead of scattering `process.env` lookups across modules.
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const SERVER_ROOT = resolve(here, '..')
export const DIST_DIR = resolve(SERVER_ROOT, '..', 'dist')

function num(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : fallback
}

function int(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function flag(value, fallback) {
  if (value === undefined || value === '') return fallback
  return value === '1' || value === 'true'
}

function text(value, fallback) {
  const out = String(value ?? '').trim()
  return out || fallback
}

export const NODE_ENV = text(process.env.NODE_ENV, 'development')
export const PORT = int(process.env.PORT, 8787)
export const TRUST_PROXY = flag(process.env.TRUST_PROXY, false)
export const MAX_PAYLOAD_BYTES = int(process.env.MAX_PAYLOAD_BYTES, 2 * 1024 * 1024)
export const MAX_SOCKETS_PER_IP = int(process.env.MAX_SOCKETS_PER_IP, 12)
export const HEARTBEAT_MS = 30 * 1000
export const WS_PATH = '/ws'
export const HTTP_HEADERS_TIMEOUT_MS = 15 * 1000
export const HTTP_REQUEST_TIMEOUT_MS = 30 * 1000
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 65 * 1000

// Comma-separated browser-origin allowlist. Defaults are local development only.
export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

// Kept only on the server. The browser exchanges this once for an HttpOnly session.
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? ''
export const ADMIN_SESSION_TTL_MS = int(process.env.ADMIN_SESSION_TTL_MS, 8 * 60 * 60 * 1000)
export const ADMIN_COOKIE_NAME = 'photovirtu_admin'

// ---------------------------------------------------------------------------
// Slot payments (QRIS)
// ---------------------------------------------------------------------------
// One paid slot buys one room: the host pays once, guests join with the invite
// code for free. Production ships gated unless the operator opts out; local
// development is ungated so a fresh clone can be used without a payment step.
export const REQUIRE_SLOT_PAYMENT = flag(process.env.REQUIRE_SLOT_PAYMENT, NODE_ENV === 'production')
export const DEFAULT_SLOT_PRICE = int(process.env.SLOT_PRICE, 25000)
export const DEFAULT_CURRENCY = text(process.env.CURRENCY, 'IDR')
export const DEFAULT_MERCHANT_NAME = text(process.env.MERCHANT_NAME, 'Photovirtu')
export const DEFAULT_PAYMENT_INSTRUCTIONS = text(
  process.env.PAYMENT_INSTRUCTIONS,
  'Scan QRIS dengan aplikasi bank atau e-wallet apa pun, bayar sesuai nominal, lalu unggah bukti transfernya.',
)
export const ORDER_TTL_MS = int(process.env.ORDER_TTL_MS, 7 * 24 * 60 * 60 * 1000)
export const MAX_PROOF_BYTES = int(process.env.MAX_PROOF_BYTES, 1_200_000)
export const MAX_QRIS_BYTES = int(process.env.MAX_QRIS_BYTES, 512_000)
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']

// node:sqlite keeps a single-file deployment dependency-free. PILOT_DB_PATH is
// still honoured so an existing pilot deployment keeps its database.
export const DB_PATH = resolve(text(process.env.SLOT_DB_PATH, text(process.env.PILOT_DB_PATH, join(SERVER_ROOT, 'data', 'photovirtu.sqlite'))))

// ---------------------------------------------------------------------------
// Room + rate limits
// ---------------------------------------------------------------------------
export const ROOM_MIN_CAPACITY = int(process.env.ROOM_MIN_CAPACITY, 2)
export const ROOM_MAX_CAPACITY = int(process.env.ROOM_MAX_CAPACITY, 4)
export const POSES_PER_SESSION = int(process.env.POSES_PER_SESSION, 4)

// Limits are configurable so tests can exercise happy and throttled paths
// without fighting one shared token bucket.
export const LIMITS = {
  join: { capacity: num(process.env.JOIN_CAPACITY, 6), refillPerSecond: num(process.env.JOIN_REFILL_PER_SEC, 6 / 60) },
  message: { capacity: num(process.env.MSG_CAPACITY, 30), refillPerSecond: num(process.env.MSG_REFILL_PER_SEC, 15) },
  share: { capacity: num(process.env.SHARE_CAPACITY, 2), refillPerSecond: num(process.env.SHARE_REFILL_PER_SEC, 2 / 20) },
  session: { capacity: num(process.env.SESSION_CAPACITY, 8), refillPerSecond: num(process.env.SESSION_REFILL_PER_SEC, 8 / 60) },
  // Creating a slot order is cheap, but it must not be usable to spam the
  // review queue or to farm QRIS order ids from a single IP.
  orderCreate: { capacity: num(process.env.ORDER_CREATE_CAPACITY, 5), refillPerSecond: num(process.env.ORDER_CREATE_REFILL_PER_SEC, 5 / 3600) },
  proof: { capacity: num(process.env.PROOF_CAPACITY, 8), refillPerSecond: num(process.env.PROOF_REFILL_PER_SEC, 8 / 600) },
  adminLogin: { capacity: num(process.env.ADMIN_LOGIN_CAPACITY, 5), refillPerSecond: num(process.env.ADMIN_LOGIN_REFILL_PER_SEC, 5 / (15 * 60)) },
}
