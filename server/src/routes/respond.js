// Status codes for the order/payment API, in one place so the browser only has
// to know a single vocabulary of error codes.
const STATUS = {
  ORDER_NOT_FOUND: 404,
  NOT_FOUND: 404,
  BAD_REQUESTER_NAME: 400,
  BAD_DECISION: 400,
  BAD_AMOUNT: 400,
  BAD_IMAGE: 400,
  BAD_IMAGE_TYPE: 400,
  BAD_JSON: 400,
  IMAGE_TOO_LARGE: 413,
  ORDER_EXPIRED: 409,
  ORDER_ALREADY_REVIEWED: 409,
  PROOF_REQUIRED: 409,
  SLOT_NOT_APPROVED: 409,
  RATE_LIMITED: 429,
}

export function errorStatus(code) {
  return STATUS[code] ?? 400
}

export function fail(res, error) {
  const code = error instanceof Error ? error.message : 'REQUEST_FAILED'
  return res.status(errorStatus(code)).json({ error: code })
}

// Uploaded images are served from our own origin (the CSP refuses third-party
// images) and never cached: a re-uploaded proof must not be served stale.
export function sendImage(res, image) {
  if (!image) return res.status(404).json({ error: 'NOT_FOUND' })
  res.set('content-type', image.mime)
  res.set('cache-control', 'no-store')
  // Helmet defaults subresources to same-origin. A split deployment (app and
  // API on different hosts) still has to render these two images, and neither
  // is secret: the QRIS is public and the proof is behind an HttpOnly,
  // SameSite=strict admin cookie that a cross-site <img> can never carry.
  res.set('cross-origin-resource-policy', 'cross-origin')
  res.set('content-length', String(image.bytes.length))
  return res.send(image.bytes)
}
