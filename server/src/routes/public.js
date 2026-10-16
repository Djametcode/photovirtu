// Public API: the single source of truth for the slot price, the QRIS image,
// and the lifecycle of one paid slot.
import { Router } from 'express'
import {
  MAX_PROOF_BYTES,
  ORDER_TTL_MS,
  POSES_PER_SESSION,
  REQUIRE_SLOT_PAYMENT,
  ROOM_MAX_CAPACITY,
  ROOM_MIN_CAPACITY,
} from '../config.js'
import { clientIp } from '../security.js'
import { attachProof, createOrder, getOrder } from '../store/orders.js'
import { decodeImageDataUrl, publicPaymentSettings, qrisImage } from '../store/settings.js'
import { fail, sendImage } from './respond.js'

export function publicRoutes({ orderCreateLimiter, proofLimiter }) {
  const router = Router()

  function publicConfig() {
    return {
      payment: {
        required: REQUIRE_SLOT_PAYMENT,
        ...publicPaymentSettings(),
      },
      room: { minCapacity: ROOM_MIN_CAPACITY, maxCapacity: ROOM_MAX_CAPACITY, poses: POSES_PER_SESSION },
      order: { ttlMs: ORDER_TTL_MS, maxProofBytes: MAX_PROOF_BYTES },
    }
  }

  // Cheapest possible way for the app to render the correct price and whether a
  // payment step is needed at all: one call on boot, then cached in the client.
  router.get('/config', (_req, res) => res.status(200).json(publicConfig()))

  router.post('/orders', (req, res) => {
    if (!orderCreateLimiter(clientIp(req))) return res.status(429).json({ error: 'RATE_LIMITED' })
    try {
      const { order, token } = createOrder(req.body ?? {})
      // The token is returned exactly once and never persisted client-side
      // beyond the payer's own browser storage.
      return res.status(201).json({ order, token, payment: publicConfig().payment })
    } catch (error) {
      return fail(res, error)
    }
  })

  router.get('/orders/:id', (req, res) => {
    const order = getOrder(req.params.id, req.get('x-order-token'))
    if (!order) return res.status(404).json({ error: 'ORDER_NOT_FOUND' })
    return res.status(200).json({ order, payment: publicConfig().payment })
  })

  router.post('/orders/:id/proof', (req, res) => {
    if (!proofLimiter(clientIp(req))) return res.status(429).json({ error: 'RATE_LIMITED' })
    try {
      const image = decodeImageDataUrl(req.body?.image, MAX_PROOF_BYTES)
      const order = attachProof(req.params.id, req.get('x-order-token'), image)
      return res.status(200).json({ order })
    } catch (error) {
      return fail(res, error)
    }
  })

  router.get('/qris', (_req, res) => sendImage(res, qrisImage()))

  return router
}
