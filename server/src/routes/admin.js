// Admin API: a password exchanged for an HttpOnly session, then everything the
// operator needs — the review queue with payment proofs, and the QRIS/price
// settings that drive the public checkout screen.
import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import {
  ADMIN_COOKIE_NAME,
  ADMIN_PASSWORD,
  ADMIN_SESSION_TTL_MS,
  MAX_QRIS_BYTES,
  NODE_ENV,
  REQUIRE_SLOT_PAYMENT,
} from '../config.js'
import { clientIp, safeEqual } from '../security.js'
import { listOrders, ordersSummary, proofFor, reviewOrder } from '../store/orders.js'
import { clearQris, decodeImageDataUrl, publicPaymentSettings, saveQris, updatePaymentSettings } from '../store/settings.js'
import { fail, sendImage } from './respond.js'

const sessions = new Map()

function clearExpired() {
  const now = Date.now()
  for (const [id, expiresAt] of sessions) if (expiresAt <= now) sessions.delete(id)
}

function cookieValue(req, name) {
  const prefix = `${name}=`
  return String(req.headers.cookie ?? '')
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? ''
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: NODE_ENV === 'production',
    path: '/api/admin',
    maxAge: ADMIN_SESSION_TTL_MS,
  }
}

export function requireAdmin(req, res, next) {
  // Without a configured password the admin surface does not exist at all,
  // rather than existing with an empty password.
  if (!ADMIN_PASSWORD) return res.status(404).json({ error: 'not_found' })
  clearExpired()
  const sessionId = cookieValue(req, ADMIN_COOKIE_NAME)
  if (!sessionId || !sessions.has(sessionId)) return res.status(401).json({ error: 'unauthorized' })
  return next()
}

export function adminRoutes({ adminLoginLimiter }) {
  const router = Router()

  router.post('/login', (req, res) => {
    if (!ADMIN_PASSWORD) return res.status(404).json({ error: 'not_found' })
    if (!adminLoginLimiter(clientIp(req))) return res.status(429).json({ error: 'rate_limited' })
    if (!safeEqual(String(req.body?.password ?? ''), ADMIN_PASSWORD)) return res.status(401).json({ error: 'unauthorized' })

    clearExpired()
    const sessionId = randomBytes(32).toString('base64url')
    sessions.set(sessionId, Date.now() + ADMIN_SESSION_TTL_MS)
    res.cookie(ADMIN_COOKIE_NAME, sessionId, cookieOptions())
    return res.status(204).end()
  })

  router.post('/logout', requireAdmin, (req, res) => {
    sessions.delete(cookieValue(req, ADMIN_COOKIE_NAME))
    // Expiry is cleared by clearCookie itself: send the same attributes minus maxAge.
    const { maxAge: _ttl, ...rest } = cookieOptions()
    res.clearCookie(ADMIN_COOKIE_NAME, rest)
    return res.status(204).end()
  })

  router.get('/orders', requireAdmin, (req, res) => {
    const status = String(req.query.status ?? 'QUEUE')
    return res.status(200).json({ orders: listOrders(status, req.query.limit), summary: ordersSummary() })
  })

  router.get('/orders/:id/proof', requireAdmin, (req, res) => sendImage(res, proofFor(req.params.id)))

  router.post('/orders/:id/review', requireAdmin, (req, res) => {
    try {
      const order = reviewOrder(req.params.id, String(req.body?.decision ?? ''), 'admin', req.body?.note)
      return res.status(200).json({ order, summary: ordersSummary() })
    } catch (error) {
      return fail(res, error)
    }
  })

  router.get('/settings', requireAdmin, (_req, res) => {
    return res.status(200).json({ settings: publicPaymentSettings(), requirePayment: REQUIRE_SLOT_PAYMENT })
  })

  router.put('/settings', requireAdmin, (req, res) => {
    try {
      updatePaymentSettings(req.body ?? {})
      return res.status(200).json({ settings: publicPaymentSettings(), requirePayment: REQUIRE_SLOT_PAYMENT })
    } catch (error) {
      return fail(res, error)
    }
  })

  router.put('/settings/qris', requireAdmin, (req, res) => {
    try {
      const image = decodeImageDataUrl(req.body?.image, MAX_QRIS_BYTES)
      saveQris(image)
      return res.status(200).json({ settings: publicPaymentSettings(), requirePayment: REQUIRE_SLOT_PAYMENT })
    } catch (error) {
      return fail(res, error)
    }
  })

  router.delete('/settings/qris', requireAdmin, (_req, res) => {
    clearQris()
    return res.status(200).json({ settings: publicPaymentSettings(), requirePayment: REQUIRE_SLOT_PAYMENT })
  })

  return router
}
