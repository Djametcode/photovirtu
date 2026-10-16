// Operator-editable payment settings: the QRIS image, its nominal, and the
// merchant copy shown on the checkout screen. Values fall back to the
// environment so a fresh install already has a sensible price.
import {
  ALLOWED_IMAGE_TYPES,
  DEFAULT_CURRENCY,
  DEFAULT_MERCHANT_NAME,
  DEFAULT_PAYMENT_INSTRUCTIONS,
  DEFAULT_SLOT_PRICE,
  MAX_QRIS_BYTES,
} from '../config.js'
import { db, tx } from '../db.js'

const KEYS = {
  amount: 'payment.amount',
  currency: 'payment.currency',
  merchant: 'payment.merchant',
  instructions: 'payment.instructions',
}

function readSetting(key) {
  return db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? ''
}

function writeSetting(key, value) {
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value), Date.now())
}

function cleanLine(value, fallback, maxLength) {
  const out = String(value ?? '')
    .split('')
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code > 0x1f && code !== 0x7f
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
  return out || fallback
}

export function qrisInfo() {
  const row = db.prepare('SELECT mime, size, updated_at FROM payment_qris WHERE id = 1').get()
  if (!row) return { present: false, mime: null, size: 0, updatedAt: null }
  return { present: true, mime: row.mime, size: row.size, updatedAt: row.updated_at }
}

export function qrisImage() {
  const row = db.prepare('SELECT mime, bytes FROM payment_qris WHERE id = 1').get()
  if (!row?.bytes) return null
  return { mime: row.mime, bytes: Buffer.from(row.bytes) }
}

export function paymentSettings() {
  const amount = Number.parseInt(readSetting(KEYS.amount), 10)
  return {
    amount: Number.isFinite(amount) && amount > 0 ? amount : DEFAULT_SLOT_PRICE,
    currency: cleanLine(readSetting(KEYS.currency), DEFAULT_CURRENCY, 8).toUpperCase(),
    merchant: cleanLine(readSetting(KEYS.merchant), DEFAULT_MERCHANT_NAME, 80),
    instructions: cleanLine(readSetting(KEYS.instructions), DEFAULT_PAYMENT_INSTRUCTIONS, 400),
    qris: qrisInfo(),
  }
}

// The operator API and the public config share one flat shape so the browser
// only ever deals with a single PaymentConfig type.
export function publicPaymentSettings() {
  const { qris, ...rest } = paymentSettings()
  return { ...rest, hasQris: qris.present, qrisUpdatedAt: qris.updatedAt }
}

export function updatePaymentSettings(input) {
  const amount = Number.parseInt(String(input?.amount ?? ''), 10)
  if (!Number.isFinite(amount) || amount < 0 || amount > 100_000_000) throw new Error('BAD_AMOUNT')
  return tx(() => {
    writeSetting(KEYS.amount, amount)
    if (input?.currency !== undefined) writeSetting(KEYS.currency, cleanLine(input.currency, DEFAULT_CURRENCY, 8).toUpperCase())
    if (input?.merchant !== undefined) writeSetting(KEYS.merchant, cleanLine(input.merchant, DEFAULT_MERCHANT_NAME, 80))
    if (input?.instructions !== undefined) writeSetting(KEYS.instructions, cleanLine(input.instructions, DEFAULT_PAYMENT_INSTRUCTIONS, 400))
    return paymentSettings()
  })
}

// Decode a `data:image/...;base64,` payload. Anything that is not a supported
// raster image is refused, so the admin surface cannot be used as file storage.
export function decodeImageDataUrl(dataUrl, maxBytes) {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl ?? '').trim())
  if (!match) throw new Error('BAD_IMAGE')
  const mime = match[1].toLowerCase()
  if (!ALLOWED_IMAGE_TYPES.includes(mime)) throw new Error('BAD_IMAGE_TYPE')
  const bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64')
  if (!bytes.length) throw new Error('BAD_IMAGE')
  if (bytes.length > maxBytes) throw new Error('IMAGE_TOO_LARGE')
  return { mime, bytes }
}

export function saveQris({ mime, bytes }) {
  if (!ALLOWED_IMAGE_TYPES.includes(mime)) throw new Error('BAD_IMAGE_TYPE')
  if (!bytes?.length) throw new Error('BAD_IMAGE')
  if (bytes.length > MAX_QRIS_BYTES) throw new Error('IMAGE_TOO_LARGE')
  return tx(() => {
    db.prepare(`INSERT INTO payment_qris (id, mime, size, bytes, updated_at) VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET mime = excluded.mime, size = excluded.size, bytes = excluded.bytes, updated_at = excluded.updated_at`)
      .run(mime, bytes.length, bytes, Date.now())
    return qrisInfo()
  })
}

export function clearQris() {
  return tx(() => {
    db.prepare('DELETE FROM payment_qris WHERE id = 1').run()
    return qrisInfo()
  })
}
