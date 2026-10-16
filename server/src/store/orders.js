// Paid slots. One order = one room: the host pays with QRIS, uploads a proof,
// an admin approves it, and the room creation consumes the slot exactly once.
// There is no free-slot quota — approval is the only gate.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { ALLOWED_IMAGE_TYPES, MAX_PROOF_BYTES, ORDER_TTL_MS, ROOM_MAX_CAPACITY, ROOM_MIN_CAPACITY } from '../config.js'
import { db, tx } from '../db.js'
import { paymentSettings } from './settings.js'

export const ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'PENDING_REVIEW',
  'APPROVED',
  'ACTIVATED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
]

function tokenHash(token) {
  return createHash('sha256').update(String(token ?? '')).digest('hex')
}

function cleanText(value, fallback, maxLength) {
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

function clampCapacity(value) {
  const parsed = Number.parseInt(String(value ?? ROOM_MAX_CAPACITY), 10)
  const size = Number.isFinite(parsed) ? parsed : ROOM_MAX_CAPACITY
  return Math.min(Math.max(size, ROOM_MIN_CAPACITY), ROOM_MAX_CAPACITY)
}

export function publicOrder(row) {
  if (!row) return null
  return {
    id: row.id,
    reference: String(row.id).slice(0, 8).toUpperCase(),
    requesterName: row.requester_name,
    eventName: row.event_name,
    templateId: row.template_id,
    capacity: row.capacity,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at,
    proofAt: row.proof_at,
    hasProof: Boolean(row.proof_at),
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    activatedAt: row.activated_at,
    expiresAt: row.expires_at,
  }
}

function rowById(id) {
  return db.prepare('SELECT * FROM slot_orders WHERE id = ?').get(id)
}

function rowForToken(token) {
  return db.prepare('SELECT * FROM slot_orders WHERE token_hash = ?').get(tokenHash(token))
}

function expireIfNeeded(row, now = Date.now()) {
  if (!['PENDING_PAYMENT', 'PENDING_REVIEW'].includes(row.status)) return false
  if (row.expires_at > now) return false
  db.prepare(`UPDATE slot_orders SET status = 'EXPIRED', reviewed_at = ?, review_note = 'Order expired'
    WHERE id = ? AND status IN ('PENDING_PAYMENT','PENDING_REVIEW')`).run(now, row.id)
  return true
}

// Both the payer's actions (upload proof, cancel) and the admin's actions are
// only legal while an order is still open; anything else must be reported with
// the reason the operator can act on.
function assertOpen(row) {
  if (expireIfNeeded(row) || row.status === 'EXPIRED') throw new Error('ORDER_EXPIRED')
}

// A fresh order snapshots the current price, so changing the price later never
// silently re-prices work a guest is already paying for.
export function createOrder(input) {
  const requesterName = cleanText(input?.requesterName, '', 80)
  if (requesterName.length < 2) throw new Error('BAD_REQUESTER_NAME')

  const settings = paymentSettings()
  const id = randomUUID()
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  const expiresAt = now + ORDER_TTL_MS

  db.prepare(`INSERT INTO slot_orders
    (id, token_hash, requester_name, event_name, template_id, capacity, amount, currency, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_PAYMENT', ?, ?)`)
    .run(
      id,
      tokenHash(token),
      requesterName,
      cleanText(input?.eventName, 'Photovirtu room', 100),
      cleanText(input?.templateId, 'web-rush', 40),
      clampCapacity(input?.capacity),
      settings.amount,
      settings.currency,
      now,
      expiresAt,
    )

  return { order: publicOrder(rowById(id)), token }
}

// The token is the only credential for the payer: it is never stored in
// plaintext and is required for every status check or proof upload.
export function getOrder(id, token) {
  const row = rowForToken(token)
  if (!row || row.id !== id) return null
  expireIfNeeded(row)
  return publicOrder(rowById(id))
}

export function attachProof(id, token, { mime, bytes }) {
  if (!ALLOWED_IMAGE_TYPES.includes(mime)) throw new Error('BAD_IMAGE_TYPE')
  if (!bytes?.length) throw new Error('BAD_IMAGE')
  if (bytes.length > MAX_PROOF_BYTES) throw new Error('IMAGE_TOO_LARGE')

  return tx(() => {
    const row = rowForToken(token)
    if (!row || row.id !== id) throw new Error('ORDER_NOT_FOUND')
    assertOpen(row)
    if (!['PENDING_PAYMENT', 'PENDING_REVIEW'].includes(row.status)) throw new Error('ORDER_ALREADY_REVIEWED')

    const now = Date.now()
    db.prepare(`INSERT INTO order_proofs (order_id, mime, size, bytes, uploaded_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(order_id) DO UPDATE SET mime = excluded.mime, size = excluded.size, bytes = excluded.bytes, uploaded_at = excluded.uploaded_at`)
      .run(id, mime, bytes.length, bytes, now)
    // Re-uploading before review simply replaces the proof and keeps the order
    // in the review queue instead of bouncing the payer back to payment.
    db.prepare("UPDATE slot_orders SET proof_at = ?, status = 'PENDING_REVIEW' WHERE id = ?").run(now, id)
    return publicOrder(rowById(id))
  })
}

export function proofFor(id) {
  const row = db.prepare('SELECT mime, size, bytes, uploaded_at FROM order_proofs WHERE order_id = ?').get(id)
  if (!row) return null
  return { mime: row.mime, size: row.size, bytes: Buffer.from(row.bytes), uploadedAt: row.uploaded_at }
}

export function ordersSummary() {
  const counts = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) AS count FROM slot_orders GROUP BY status').all().map((row) => [row.status, row.count]),
  )
  const revenue = db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM slot_orders WHERE status IN ('APPROVED','ACTIVATED')").get().total
  const awaitingAmount = db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM slot_orders WHERE status = 'PENDING_REVIEW'").get().total
  const currency = paymentSettings().currency
  return {
    currency,
    awaitingPayment: counts.PENDING_PAYMENT ?? 0,
    awaitingReview: counts.PENDING_REVIEW ?? 0,
    approved: counts.APPROVED ?? 0,
    activated: counts.ACTIVATED ?? 0,
    rejected: counts.REJECTED ?? 0,
    expired: counts.EXPIRED ?? 0,
    cancelled: counts.CANCELLED ?? 0,
    revenue,
    awaitingAmount,
  }
}

export function listOrders(status = 'PENDING_REVIEW', limit = 100) {
  const allowed = new Set([...ORDER_STATUSES, 'ALL', 'QUEUE'])
  const chosen = allowed.has(status) ? status : 'PENDING_REVIEW'
  const capped = Math.min(Math.max(Number.parseInt(String(limit), 10) || 100, 1), 200)
  const rows = chosen === 'ALL'
    ? db.prepare('SELECT * FROM slot_orders ORDER BY created_at DESC LIMIT ?').all(capped)
    : chosen === 'QUEUE'
      // The operator's working set: payers who need a decision, newest first.
      ? db.prepare("SELECT * FROM slot_orders WHERE status IN ('PENDING_REVIEW','PENDING_PAYMENT') ORDER BY CASE status WHEN 'PENDING_REVIEW' THEN 0 ELSE 1 END, created_at ASC LIMIT ?").all(capped)
      : db.prepare('SELECT * FROM slot_orders WHERE status = ? ORDER BY created_at ASC LIMIT ?').all(chosen, capped)
  return rows.map((row) => publicOrder(row))
}

export function expireOrders() {
  return db.prepare(`UPDATE slot_orders SET status = 'EXPIRED', reviewed_at = ?, review_note = 'Order expired'
    WHERE status IN ('PENDING_PAYMENT','PENDING_REVIEW') AND expires_at <= ?`).run(Date.now(), Date.now()).changes
}

// An order may only be approved once its payment proof exists: approval means
// "the money arrived", not "the request looks fine".
export function reviewOrder(id, decision, adminId, note = '') {
  if (!['APPROVED', 'REJECTED'].includes(decision)) throw new Error('BAD_DECISION')

  return tx(() => {
    const row = rowById(id)
    if (!row) throw new Error('ORDER_NOT_FOUND')
    assertOpen(row)
    // Approval means "the money arrived", so a proof must exist before an
    // operator can mark an order paid.
    if (decision === 'APPROVED' && !row.proof_at) throw new Error('PROOF_REQUIRED')
    if (row.status !== 'PENDING_REVIEW') throw new Error('ORDER_ALREADY_REVIEWED')

    db.prepare('UPDATE slot_orders SET status = ?, reviewed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ?')
      .run(decision, Date.now(), cleanText(adminId, 'admin', 80), cleanText(note, '', 240), id)
    return publicOrder(rowById(id))
  })
}

export function cancelOrder(id, token) {
  return tx(() => {
    const row = rowForToken(token)
    if (!row || row.id !== id) throw new Error('ORDER_NOT_FOUND')
    assertOpen(row)
    if (!['PENDING_PAYMENT', 'PENDING_REVIEW'].includes(row.status)) throw new Error('ORDER_ALREADY_REVIEWED')
    db.prepare("UPDATE slot_orders SET status = 'CANCELLED' WHERE id = ?").run(id)
    return publicOrder(rowById(id))
  })
}

// Consumed when the host creates the realtime room. The transition is atomic, so
// two parallel create frames can never share one paid slot.
export function activateOrder(token) {
  const now = Date.now()
  const result = db.prepare(`UPDATE slot_orders SET status = 'ACTIVATED', activated_at = ?
    WHERE token_hash = ? AND status = 'APPROVED' AND expires_at > ?`)
    .run(now, tokenHash(token), now)
  if (result.changes !== 1) throw new Error('SLOT_NOT_APPROVED')
  return publicOrder(rowForToken(token))
}

// Room allocation is the only failure path after the slot is consumed, so it
// must be able to hand the slot back instead of charging for nothing.
export function restoreOrder(token) {
  return db.prepare(`UPDATE slot_orders SET status = 'APPROVED', activated_at = NULL
    WHERE token_hash = ? AND status = 'ACTIVATED'`).run(tokenHash(token)).changes === 1
}
