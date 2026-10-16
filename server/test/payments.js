// Paid-slot gate: a room only exists after a QRIS payment proof is approved by
// an admin. There is no free-slot quota — approval is the only limit.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { rm } from 'node:fs/promises'
import { WebSocket } from 'ws'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '..', 'src', 'index.js')
const port = 8910
const base = `http://127.0.0.1:${port}`
const wsUrl = `ws://127.0.0.1:${port}/ws`
const dbPath = join(here, '..', 'data', 'payments-test.sqlite')
const adminPassword = 'payments-test-admin-password'
const price = 15000
// Smallest valid PNG: enough to prove mime handling and byte-exact serving.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG.split(',')[1], 'base64').length

let adminCookie = ''
const results = []

function check(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function request(path, options = {}) {
  return fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(adminCookie ? { cookie: adminCookie } : {}), ...(options.headers ?? {}) },
  })
}

async function json(path, options) {
  const response = await request(path, options)
  return { response, body: await response.json().catch(() => ({})) }
}

async function loginAdmin(password = adminPassword) {
  const response = await request('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) })
  const cookie = response.headers.get('set-cookie')
  if (cookie) adminCookie = cookie.split(';')[0]
  return response
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { origin: 'http://localhost:5173' })
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

async function createRoom(slotToken, keepOpen = false) {
  let ws
  try {
    ws = await connect()
    const message = await new Promise((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw.toString('utf8'))))
      ws.send(JSON.stringify({ type: 'create', hostName: 'Paid Host', templateId: 'web-rush', roomSize: 8, slotToken }))
    })
    if (!keepOpen) ws.close()
    return keepOpen ? { message, ws } : message
  } catch (error) {
    ws?.close()
    throw error
  }
}

// One slot order, from creation to an approved payment: the shortest path to a
// state where a room may exist.
async function payForSlot(name, capacity = 4) {
  const created = await json('/api/orders', {
    method: 'POST',
    body: JSON.stringify({ requesterName: name, eventName: `${name} event`, capacity }),
  })
  const order = created.body.order
  const token = created.body.token
  await request(`/api/orders/${order.id}/proof`, {
    method: 'POST',
    headers: { 'x-order-token': token },
    body: JSON.stringify({ image: PNG }),
  })
  await request(`/api/admin/orders/${order.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'APPROVED' }) })
  const final = await json(`/api/orders/${order.id}`, { headers: { 'x-order-token': token } })
  return { order: final.body.order, token }
}

async function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      PORT: String(port),
      REQUIRE_SLOT_PAYMENT: '1',
      SLOT_PRICE: String(price),
      SLOT_DB_PATH: dbPath,
      ADMIN_PASSWORD: adminPassword,
      ALLOWED_ORIGINS: 'http://localhost:5173',
      JOIN_CAPACITY: '100',
      MSG_CAPACITY: '1000',
      ORDER_CREATE_CAPACITY: '100',
      ORDER_CREATE_REFILL_PER_SEC: '100',
      PROOF_CAPACITY: '100',
      PROOF_REFILL_PER_SEC: '100',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('payments server did not start')), 8000)
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening on')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.stderr.on('data', (chunk) => process.stderr.write(`[payments] ${chunk}`))
  })
  return child
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    child.once('exit', resolve)
    child.kill()
    setTimeout(resolve, 3000).unref()
  })
}

async function main() {
  await rm(dbPath, { force: true })
  const child = await startServer()
  try {
    // --- public config + order lifecycle ---------------------------------
    const config = await json('/api/config')
    check('config exposes the QRIS price and gate', config.body.payment?.required === true && config.body.payment?.amount === price)
    check('config reports no QRIS image before the admin uploads one', config.body.payment?.hasQris === false)
    check('config clamps the room to four participants', config.body.room?.maxCapacity === 4)

    const foreignOrigin = await request('/api/orders', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      body: JSON.stringify({ requesterName: 'Attacker', eventName: 'Foreign', capacity: 2 }),
    })
    check('foreign browser origin is rejected', foreignOrigin.status === 403)

    const ownOrigin = await request('/ready', { headers: { origin: base } })
    check('same-origin browser requests are accepted', ownOrigin.status === 200)

    const invalid = await json('/api/orders', { method: 'POST', body: JSON.stringify({ requesterName: ' ', capacity: 2 }) })
    check('blank requester name is rejected', invalid.response.status === 400 && invalid.body.error === 'BAD_REQUESTER_NAME')

    const created = await json('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ requesterName: 'TikTok User', eventName: 'Soft launch', capacity: 8, templateId: 'black-film' }),
    })
    const order = created.body.order
    const orderToken = created.body.token
    check('order starts unpaid', created.response.status === 201 && order.status === 'PENDING_PAYMENT')
    check('order snapshots the current price', order.amount === price && order.currency === 'IDR')
    check('order capacity is clamped to four people', order.capacity === 4, `capacity=${order.capacity}`)
    check('order carries a human reference', typeof order.reference === 'string' && order.reference.length === 8)

    const blocked = await createRoom(orderToken)
    check('unpaid order cannot create a realtime room', blocked.type === 'error' && blocked.code === 'SLOT_NOT_APPROVED', `code=${blocked.code}`)

    const noToken = await json(`/api/orders/${order.id}`)
    check('order status needs its payer token', noToken.response.status === 404)
    const withToken = await json(`/api/orders/${order.id}`, { headers: { 'x-order-token': orderToken } })
    check('payer can poll their own order', withToken.response.status === 200 && withToken.body.order.status === 'PENDING_PAYMENT')

    // --- proof upload ----------------------------------------------------
    const badProofToken = await json(`/api/orders/${order.id}/proof`, { method: 'POST', headers: { 'x-order-token': 'wrong' }, body: JSON.stringify({ image: PNG }) })
    check('proof upload refuses a foreign token', badProofToken.response.status === 404)

    const notAnImage = await json(`/api/orders/${order.id}/proof`, {
      method: 'POST',
      headers: { 'x-order-token': orderToken },
      body: JSON.stringify({ image: 'data:text/plain;base64,aGVsbG8=' }),
    })
    check('proof upload refuses a non-image payload', notAnImage.response.status === 400 && notAnImage.body.error === 'BAD_IMAGE_TYPE')

    const wrongShape = await json(`/api/orders/${order.id}/proof`, {
      method: 'POST',
      headers: { 'x-order-token': orderToken },
      body: JSON.stringify({ image: 'https://example.com/receipt.png' }),
    })
    check('proof upload refuses a linked image', wrongShape.response.status === 400 && wrongShape.body.error === 'BAD_IMAGE')

    const proof = await json(`/api/orders/${order.id}/proof`, {
      method: 'POST',
      headers: { 'x-order-token': orderToken },
      body: JSON.stringify({ image: PNG }),
    })
    check('proof upload moves the order into review', proof.body.order?.status === 'PENDING_REVIEW' && proof.body.order?.hasProof === true)

    // --- admin review ----------------------------------------------------
    const noSession = await request('/api/admin/orders')
    check('admin endpoint rejects missing session', noSession.status === 401)
    const wrongLogin = await loginAdmin('wrong-password')
    check('admin login rejects wrong password', wrongLogin.status === 401)
    const login = await loginAdmin()
    check('admin login creates an HttpOnly session', login.status === 204 && /HttpOnly/i.test(login.headers.get('set-cookie') ?? ''))

    const unpaidOrder = await json('/api/orders', { method: 'POST', body: JSON.stringify({ requesterName: 'No Proof', capacity: 2 }) })
    const approveUnpaid = await json(`/api/admin/orders/${unpaidOrder.body.order.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'APPROVED' }) })
    check('approval refuses an unpaid order', approveUnpaid.response.status === 409 && approveUnpaid.body.error === 'PROOF_REQUIRED', `error=${approveUnpaid.body.error}`)

    const queue = await json('/api/admin/orders?status=QUEUE')
    check('admin sees the payer queue with proofs', queue.body.orders?.length === 2 && queue.body.orders[0].hasProof === true)
    check('summary has no free-slot quota', queue.body.summary && queue.body.summary.totalSlots === undefined)
    check('summary counts the review queue', queue.body.summary?.awaitingReview === 1 && queue.body.summary?.awaitingPayment === 1)

    const proofImage = await request(`/api/admin/orders/${order.id}/proof`)
    check('admin can open the payment proof', proofImage.status === 200 && proofImage.headers.get('content-type') === 'image/png')
    check('served proof bytes are unchanged', Number(proofImage.headers.get('content-length')) === PNG_BYTES, `bytes=${proofImage.headers.get('content-length')}`)

    // Re-uploading before review replaces the proof instead of resetting it.
    const reupload = await json(`/api/orders/${order.id}/proof`, {
      method: 'POST',
      headers: { 'x-order-token': orderToken },
      body: JSON.stringify({ image: PNG }),
    })
    check('a re-uploaded proof stays in review', reupload.body.order?.status === 'PENDING_REVIEW')

    const approved = await json(`/api/admin/orders/${order.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'APPROVED', note: 'Transfer received' }) })
    check('admin approval activates the paid slot', approved.response.status === 200 && approved.body.order.status === 'APPROVED')
    check('confirmed revenue is summed', approved.body.summary?.revenue === price, `revenue=${approved.body.summary?.revenue}`)

    // --- the slot opens exactly one room ---------------------------------
    const activeConnection = await createRoom(orderToken, true)
    check('approved slot creates a realtime room', activeConnection.message.type === 'created')
    check('approved capacity caps the room', activeConnection.message.room?.capacity === 4, `capacity=${activeConnection.message.room?.capacity}`)

    const capacityUpdate = new Promise((resolve) => activeConnection.ws.once('message', (raw) => resolve(JSON.parse(raw.toString('utf8')))))
    activeConnection.ws.send(JSON.stringify({ type: 'room:update', roomSize: 8 }))
    const updated = await capacityUpdate
    check('host cannot raise capacity above the paid slot', updated.room?.capacity === 4, `capacity=${updated.room?.capacity}`)
    activeConnection.ws.close()

    const replay = await createRoom(orderToken)
    check('one slot cannot open a second room', replay.type === 'error' && replay.code === 'SLOT_NOT_APPROVED', `code=${replay.code}`)

    // --- no slot ceiling -------------------------------------------------
    let approvals = 0
    for (let index = 0; index < 3; index += 1) {
      const paid = await payForSlot(`Batch ${index}`)
      if (paid.order.status === 'APPROVED') approvals += 1
    }
    check('approvals are not capped by a free-slot quota', approvals === 3, `approved=${approvals}`)

    // --- operator settings ----------------------------------------------
    const newPrice = 20000
    const settings = await json('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ amount: newPrice, merchant: 'Studio Foto Virtu', instructions: 'Scan lalu unggah bukti.' }) })
    check('admin can set the price and merchant', settings.body.settings?.amount === newPrice && settings.body.settings?.merchant === 'Studio Foto Virtu')

    const badAmount = await json('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ amount: -5 }) })
    check('admin cannot set a negative price', badAmount.response.status === 400 && badAmount.body.error === 'BAD_AMOUNT')

    const publicAfter = await json('/api/config')
    check('public config follows the operator price', publicAfter.body.payment?.amount === newPrice && publicAfter.body.payment?.merchant === 'Studio Foto Virtu')

    const repriced = await json('/api/orders', { method: 'POST', body: JSON.stringify({ requesterName: 'New Price', capacity: 2 }) })
    check('new orders use the new price', repriced.body.order?.amount === newPrice)
    const oldOrder = await json(`/api/orders/${order.id}`, { headers: { 'x-order-token': orderToken } })
    check('already-paid orders keep their original price', oldOrder.body.order?.amount === price)

    const notImageQris = await json('/api/admin/settings/qris', { method: 'PUT', body: JSON.stringify({ image: 'data:text/plain;base64,aGVsbG8=' }) })
    check('QRIS upload refuses a non-image payload', notImageQris.response.status === 400)

    const qris = await json('/api/admin/settings/qris', { method: 'PUT', body: JSON.stringify({ image: PNG }) })
    check('admin can upload the merchant QRIS', qris.response.status === 200 && qris.body.settings?.hasQris === true)

    const publicQris = await request('/api/qris')
    check('checkout can load the uploaded QRIS', publicQris.status === 200 && publicQris.headers.get('content-type') === 'image/png')
    check('QRIS is served without caching', /no-store/.test(publicQris.headers.get('cache-control') ?? ''))
    const configWithQris = await json('/api/config')
    check('public config announces a ready QRIS', configWithQris.body.payment?.hasQris === true)

    const cleared = await json('/api/admin/settings/qris', { method: 'DELETE' })
    check('admin can remove the QRIS image', cleared.body.settings?.hasQris === false)
    const qrisGone = await request('/api/qris')
    check('removed QRIS is no longer served', qrisGone.status === 404)
  } finally {
    await stop(child)
    await rm(dbPath, { force: true })
    await rm(`${dbPath}-wal`, { force: true })
    await rm(`${dbPath}-shm`, { force: true })
  }

  // --- expiry keeps the queue honest ------------------------------------
  await rm(dbPath, { force: true })
  const expiring = await startServer({ ORDER_TTL_MS: '1' })
  try {
    const stale = await json('/api/orders', { method: 'POST', body: JSON.stringify({ requesterName: 'Slow Payer', capacity: 2 }) })
    await new Promise((resolve) => setTimeout(resolve, 25))
    const afterExpiry = await json(`/api/orders/${stale.body.order.id}`, { headers: { 'x-order-token': stale.body.token } })
    check('an unpaid order expires', afterExpiry.body.order?.status === 'EXPIRED', `status=${afterExpiry.body.order?.status}`)
    const lateProof = await json(`/api/orders/${stale.body.order.id}/proof`, {
      method: 'POST',
      headers: { 'x-order-token': stale.body.token },
      body: JSON.stringify({ image: PNG }),
    })
    check('an expired order refuses new proofs', lateProof.body.error === 'ORDER_EXPIRED', `error=${lateProof.body.error}`)
  } finally {
    await stop(expiring)
    await rm(dbPath, { force: true })
    await rm(`${dbPath}-wal`, { force: true })
    await rm(`${dbPath}-shm`, { force: true })
  }

  const failed = results.filter((result) => !result.pass)
  console.log(`\n${results.length - failed.length}/${results.length} payment checks passed`)
  if (failed.length) process.exit(1)
}

main().catch((error) => {
  console.error('harness error:', error.message)
  process.exit(2)
})
