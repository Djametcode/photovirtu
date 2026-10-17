// Slot payments: one paid slot buys one room. The host pays with QRIS, uploads
// a proof, and an admin approves it before the room can exist.
export type SlotStatus =
  | 'PENDING_PAYMENT'
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'ACTIVATED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CANCELLED'

export type SlotOrder = {
  id: string
  reference: string
  requesterName: string
  eventName: string
  templateId: string
  capacity: number
  amount: number
  currency: string
  status: SlotStatus
  createdAt: number
  proofAt?: number | null
  hasProof: boolean
  reviewedAt?: number | null
  reviewNote?: string | null
  activatedAt?: number | null
  expiresAt: number
}

export type PaymentConfig = {
  required: boolean
  amount: number
  currency: string
  merchant: string
  instructions: string
  hasQris: boolean
  qrisUpdatedAt: number | null
}

export type AppConfig = {
  payment: PaymentConfig
  room: { minCapacity: number; maxCapacity: number; poses: number }
  order: { ttlMs: number; maxProofBytes: number }
}

export type OrdersSummary = {
  currency: string
  awaitingPayment: number
  awaitingReview: number
  approved: number
  activated: number
  rejected: number
  expired: number
  cancelled: number
  revenue: number
  awaitingAmount: number
}

// The header carries the payer's capability token: it is the only credential
// for an order, so it never appears in a URL or a log line.
export const ORDER_TOKEN_HEADER = 'x-order-token'

function apiBase() {
  const configured = import.meta.env?.VITE_API_BASE as string | undefined
  if (configured) return configured.replace(/\/$/, '')
  // Production is served behind one origin. Vite's dev proxy handles this path
  // locally, avoiding mixed content and hard-coded public ports after deploy.
  return window.location.origin
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    ...options,
    // Admin auth is an HttpOnly cookie. JS never reads or stores it.
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? 'REQUEST_FAILED')
  return body
}

export function fetchConfig() {
  return api<AppConfig>('/api/config')
}

export function createSlotOrder(input: { requesterName: string; eventName: string; capacity: number; templateId: string }) {
  return api<{ order: SlotOrder; token: string; payment: PaymentConfig }>('/api/orders', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function fetchSlotOrder(id: string, token: string) {
  return api<{ order: SlotOrder; payment: PaymentConfig }>(`/api/orders/${encodeURIComponent(id)}`, {
    headers: { [ORDER_TOKEN_HEADER]: token },
  })
}

export function uploadPaymentProof(id: string, token: string, image: string) {
  return api<{ order: SlotOrder }>(`/api/orders/${encodeURIComponent(id)}/proof`, {
    method: 'POST',
    headers: { [ORDER_TOKEN_HEADER]: token },
    body: JSON.stringify({ image }),
  })
}

// Cache-busting query keeps a replaced image from being served from the cache.
export function qrisSrc(updatedAt?: number | null) {
  return `${apiBase()}/api/qris${updatedAt ? `?v=${updatedAt}` : ''}`
}

export function proofSrc(orderId: string, proofAt?: number | null) {
  return `${apiBase()}/api/admin/orders/${encodeURIComponent(orderId)}/proof${proofAt ? `?v=${proofAt}` : ''}`
}

export function loginAdmin(password: string) {
  return api<void>('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) })
}

export function logoutAdmin() {
  return api<void>('/api/admin/logout', { method: 'POST' })
}

export function listOrders(status = 'QUEUE') {
  return api<{ orders: SlotOrder[]; summary: OrdersSummary }>(`/api/admin/orders?status=${encodeURIComponent(status)}`)
}

export function reviewOrder(id: string, decision: 'APPROVED' | 'REJECTED', note = '') {
  return api<{ order: SlotOrder; summary: OrdersSummary }>(`/api/admin/orders/${encodeURIComponent(id)}/review`, {
    method: 'POST',
    body: JSON.stringify({ decision, note }),
  })
}

export function fetchAdminSettings() {
  return api<{ settings: PaymentConfig; requirePayment: boolean }>('/api/admin/settings')
}

export function saveAdminSettings(input: { amount: number; merchant: string; instructions: string; currency: string }) {
  return api<{ settings: PaymentConfig; requirePayment: boolean }>('/api/admin/settings', {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function uploadQris(image: string) {
  return api<{ settings: PaymentConfig; requirePayment: boolean }>('/api/admin/settings/qris', {
    method: 'PUT',
    body: JSON.stringify({ image }),
  })
}

export function deleteQris() {
  return api<{ settings: PaymentConfig; requirePayment: boolean }>('/api/admin/settings/qris', { method: 'DELETE' })
}

export function formatMoney(amount: number, currency = 'IDR') {
  try {
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount)
  } catch {
    return `${currency} ${amount}`
  }
}

// Shared by the checkout proof upload and the admin QRIS upload: read the file
// in the browser. Oversized photos (phone screenshots are routinely 1.5-4 MB)
// are downscaled and re-encoded through a canvas instead of rejected: the
// server cap only ever sees post-compression bytes, so the payer never has to
// compress anything by hand. Only files the canvas cannot handle fall back to
// the strict size check.
const MAX_CANVAS_DIMENSION = 1600

export async function readImageAsDataUrl(file: File, maxBytes: number) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('BAD_IMAGE_TYPE')
  if (file.size <= maxBytes) {
    // Small enough as-is: skip the canvas entirely to keep EXIF and quality.
    const buffer = await file.arrayBuffer()
    if (buffer.byteLength > maxBytes) throw new Error('IMAGE_TOO_LARGE')
    const bytes = new Uint8Array(buffer)
    let smallBinary = ''
    for (let index = 0; index < bytes.length; index += 0x8000) {
      smallBinary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
    }
    return `data:${file.type};base64,${btoa(smallBinary)}`
  }

  const compressed = await compressImageThroughCanvas(file, maxBytes)
  if (compressed) return compressed
  throw new Error('IMAGE_TOO_LARGE')
}

// Draw the image into a canvas scaled to fit MAX_CANVAS_DIMENSION, then
// re-encode as JPEG/webp with a quality ladder until the result fits maxBytes.
async function compressImageThroughCanvas(file: File, maxBytes: number) {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_CANVAS_DIMENSION / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()

    const types = file.type === 'image/png' || file.type === 'image/webp'
      ? ['image/webp', 'image/jpeg']
      : ['image/jpeg']
    for (const type of types) {
      for (const quality of [0.85, 0.7, 0.55, 0.4]) {
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
        if (blob && blob.size <= maxBytes) {
          const bytes = new Uint8Array(await blob.arrayBuffer())
          let binary = ''
          for (let index = 0; index < bytes.length; index += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
          }
          return `data:${type};base64,${btoa(binary)}`
        }
      }
    }
  } catch {
    // createImageBitmap or toBlob failed (unsupported format, memory); fall
    // through to the size rejection so the user still gets a clear error.
  }
  return null
}

export function slotErrorMessage(error: unknown) {
  const code = error instanceof Error ? error.message : 'REQUEST_FAILED'
  switch (code) {
    case 'BAD_REQUESTER_NAME':
      return 'Nama minimal 2 karakter ya.'
    case 'BAD_IMAGE':
      return 'Format gambar tidak dikenali. Pakai JPG, PNG, atau WebP.'
    case 'BAD_IMAGE_TYPE':
      return 'Hanya JPG, PNG, atau WebP yang bisa diunggah.'
    case 'IMAGE_TOO_LARGE':
      return 'Ukuran gambar terlalu besar. Coba foto ulang atau kompres dulu.'
    case 'ORDER_NOT_FOUND':
    case 'not_found':
      return 'Order tidak ditemukan. Mulai ulang dari halaman setup.'
    case 'ORDER_EXPIRED':
      return 'Order ini sudah kedaluwarsa. Buat order baru ya.'
    case 'ORDER_ALREADY_REVIEWED':
      return 'Order ini sudah diproses admin.'
    case 'PROOF_REQUIRED':
      return 'Unggah bukti transfer dulu sebelum disetujui.'
    case 'BAD_AMOUNT':
      return 'Nominal tidak valid.'
    case 'RATE_LIMITED':
    case 'rate_limited':
      return 'Terlalu banyak percobaan. Coba lagi nanti.'
    case 'unauthorized':
      return 'Password admin salah atau sesi sudah berakhir.'
    case 'origin_not_allowed':
      return 'Permintaan ditolak server (origin tidak dikenal).'
    default:
      return 'Request belum dapat diproses. Coba lagi.'
  }
}
