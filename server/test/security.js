// Adversarial verification. Runs against dedicated server instances started
// with tuned limits, so each phase tests the property it claims to test
// instead of fighting another phase over the same token bucket.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocket } from 'ws'
import { hashCode, generateInviteCode, normaliseCode, safeEqual } from '../src/security.js'

const here = dirname(fileURLToPath(import.meta.url))
const serverEntry = join(here, '..', 'src', 'index.js')
const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function startServer(port, env = {}) {
  const child = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server on ${port} did not start`)), 8000)
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening on')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.stderr.on('data', (chunk) => process.stderr.write(`[server:${port}] ${chunk}`))
  })
  return child
}

function connect(url, origin = 'http://localhost:5173') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin })
    ws.inbox = []
    ws.waiters = []
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'))
      const w = ws.waiters.shift()
      if (w) w(msg)
      else ws.inbox.push(msg)
    })
    ws.next = (timeoutMs = 2500) =>
      new Promise((res, rej) => {
        if (ws.inbox.length) return res(ws.inbox.shift())
        const t = setTimeout(() => rej(new Error('timeout')), timeoutMs)
        ws.waiters.push((m) => {
          clearTimeout(t)
          res(m)
        })
      })
    ws.sendJson = (o) => ws.send(JSON.stringify(o))
    ws.drain = async (waitMs = 400) => {
      await sleep(waitMs)
      const out = ws.inbox.slice()
      ws.inbox.length = 0
      return out
    }
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function tryConnect(url, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { origin })
    ws.on('open', () => {
      ws.close()
      resolve(true)
    })
    ws.on('error', () => resolve(false))
  })
}

// ---------------------------------------------------------------- entropy
// The real defence against guessing is the code space, not the limiter.
// Brute-force the hash function directly across a huge sample.
function testEntropy() {
  const roomCode = generateInviteCode()
  const roomHash = hashCode(roomCode)
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let collisions = 0
  const attempts = 200000
  for (let i = 0; i < attempts; i += 1) {
    const guess = Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * 32)]).join('')
    if (hashCode(guess) === roomHash) collisions += 1
  }
  check(`brute-forcing ${attempts.toLocaleString('en-US')} codes finds no match`, collisions === 0, `collisions=${collisions}`)

  // 32^8 keyspace
  const keyspace = Math.pow(32, 8)
  check('invite keyspace exceeds 1e12', keyspace > 1e12, `keyspace=${keyspace.toExponential(2)}`)

  // Normalisation is idempotent and case/format insensitive.
  check('normalisation is format-insensitive', normaliseCode(' ab-cd 12! ') === 'ABCD12', normaliseCode(' ab-cd 12! '))
  check('hash is stable across format variants', hashCode('abcd-1234') === hashCode('ABCD1234'))
  check('constant-time compare accepts equal values', safeEqual('abc', 'abc') === true)
  check('constant-time compare rejects different values', safeEqual('abc', 'abd') === false)
  check('constant-time compare rejects length mismatch', safeEqual('abc', 'abcd') === false)
}

// ---------------------------------------------------------------- generous server
async function testHappyAndHardening(port) {
  const base = `ws://127.0.0.1:${port}/ws`

  const host = await connect(base)
  host.sendJson({ type: 'create', hostName: 'Host', templateId: 'web-rush', roomSize: 4 })
  const created = await host.next()
  check('create returns an 8-char code from the safe alphabet', /^[0-9A-HJKMNP-TV-Z]{8}$/.test(created.code), `code=${created.code}`)
  check('response carries host capability token', typeof created.hostToken === 'string' && created.hostToken.length >= 32)
  check('response does not echo a plaintext code field twice', created.room?.code === undefined)

  // Cross-origin handshake must fail
  check('cross-origin websocket refused', (await tryConnect(base, 'https://evil.example.com')) === false)

  // Normalisation path
  const messy = created.code.slice(0, 4) + '-' + created.code.slice(4).toLowerCase()
  const guest = await connect(base)
  guest.sendJson({ type: 'join', code: messy, name: 'Messy' })
  const joined = await guest.next()
  check('join accepts lowercase + dashed code', joined.type === 'joined', `input=${messy}`)
  check('guest is not granted host role', joined.isHost === false)

  // Fill the room and verify that reusing somebody's display name cannot evict
  // them. Names are presentation data, never reconnect credentials.
  const guest2 = await connect(base)
  guest2.sendJson({ type: 'join', code: created.code, name: 'Second' })
  await guest2.next()
  await host.drain()
  const guest3 = await connect(base)
  guest3.sendJson({ type: 'join', code: created.code, name: 'Third' })
  await guest3.next()
  await host.drain()
  await guest.drain() // discard peer:joined roster updates before assertion messages
  const impersonator = await connect(base)
  impersonator.sendJson({ type: 'join', code: created.code, name: 'Messy' })
  const fullReply = await impersonator.next()
  check('duplicate display name cannot evict a peer from a full room', fullReply.type === 'error' && fullReply.code === 'ROOM_FULL')
  impersonator.close()

  // Wrong codes
  for (const bad of ['ZZZZZZZZ', '', '   ', 'short', '12345678']) {
    const probe = await connect(base)
    probe.sendJson({ type: 'join', code: bad, name: 'probe' })
    const reply = await probe.next(2000)
    check(`join refused for code ${JSON.stringify(bad)}`, reply.type === 'error', `code=${reply.code}`)
    probe.close()
  }

  // Name hardening
  guest.sendJson({ type: 'self:rename', name: 'x'.repeat(200) + '\u0000\u0007' })
  const renamed = await guest.next()
  const myName = renamed.peers?.find((p) => p.id === joined.selfId)?.name ?? ''
  check('display name capped at 24 chars', myName.length > 0 && myName.length <= 24, `len=${myName.length}`)
  check('control characters stripped from name', [...myName].every((char) => {
    const code = char.charCodeAt(0)
    return code > 0x1f && code !== 0x7f
  }))
  await host.drain() // flush peer:update broadcast caused by the rename

  // Signalling scope
  const hostPeerId = joined.room.peers.find((p) => p.role === 'host').id
  guest.sendJson({ type: 'signal', target: hostPeerId, data: { sdp: 'v=0 offer' } })
  const hostMessages = await host.drain()
  const relayed = hostMessages.find((m) => m.type === 'signal')
  check('signal relayed to in-room peer', Boolean(relayed) && relayed.from === joined.selfId)
  guest.sendJson({ type: 'signal', target: 'ghost-peer', data: { sdp: 'x' } })
  check('signal to non-member refused', (await guest.next()).code === 'PEER_NOT_FOUND')

  // SDP size cap
  guest.sendJson({ type: 'signal', target: hostPeerId, data: { sdp: 'x'.repeat(50000) } })
  check('oversize SDP refused', (await guest.next()).code === 'SIGNAL_TOO_LARGE')

  // Privilege boundary
  guest.sendJson({ type: 'host:kick', peerId: joined.selfId })
  check('guest cannot kick', (await guest.next()).code === 'NOT_HOST')
  guest.sendJson({ type: 'room:update', templateId: 'hacked' })
  check('guest cannot change room template', (await guest.next()).code === 'NOT_HOST')

  // Share hardening
  guest.sendJson({ type: 'share', image: 'javascript:alert(1)' })
  check('non-image share refused', (await guest.next()).code === 'BAD_IMAGE')
  guest.sendJson({ type: 'share', image: 'data:image/png;base64,' + 'A'.repeat(1600000) })
  check('oversize image share refused', (await guest.next()).code === 'IMAGE_TOO_LARGE')

  // Unknown types
  await host.drain()
  host.sendJson({ type: 'evil:whatever' })
  const unknownReplies = await host.drain()
  check('unknown message type refused', unknownReplies.some((m) => m.type === 'error' && m.code === 'UNKNOWN_TYPE'))

  // Payload ceiling enforced by transport
  let closed = false
  const big = await connect(base)
  big.on('close', () => {
    closed = true
  })
  big.send('x'.repeat(3 * 1024 * 1024))
  await sleep(600)
  check('oversize frame closes socket', closed === true)

  host.close()
  guest.close()
  guest2.close()
  guest3.close()
  big.close()
  await sleep(200)
}

// ---------------------------------------------------------------- tight server
async function testRateLimiting(port) {
  const base = `ws://127.0.0.1:${port}/ws`
  const ws = await connect(base)
  for (let i = 0; i < 40; i += 1) ws.sendJson({ type: 'join', code: 'AAAAAAAA', name: 'flood' })
  await sleep(800)
  let limited = 0
  while (ws.inbox.length) {
    const m = ws.inbox.shift()
    if (m.type === 'error' && m.code === 'RATE_LIMITED') limited += 1
  }
  check('join flood is rate limited', limited > 0, `throttled=${limited}/40`)
  ws.close()

  // Message flood on an established socket must also throttle.
  const host = await connect(base)
  host.sendJson({ type: 'create', hostName: 'H', templateId: 'web-rush', roomSize: 2 })
  await host.next()
  for (let i = 0; i < 60; i += 1) host.sendJson({ type: 'self:mute', muted: i % 2 === 0 })
  await sleep(800)
  let msgLimited = false
  while (host.inbox.length) {
    const m = host.inbox.shift()
    if (m.type === 'error' && m.code === 'RATE_LIMITED') msgLimited = true
  }
  check('message flood is rate limited', msgLimited === true)
  host.close()
}

async function main() {
  testEntropy()

  const openPort = 8901
  const tightPort = 8902
  const open = startServer(openPort, { JOIN_CAPACITY: '500', MSG_CAPACITY: '2000' })
  const tight = startServer(tightPort, { JOIN_CAPACITY: '6', MSG_CAPACITY: '30', MSG_REFILL_PER_SEC: '1' })

  try {
    await Promise.all([open.ready, tight.ready])
    await testHappyAndHardening(openPort)
    await testRateLimiting(tightPort)
  } finally {
    open.kill()
    tight.kill()
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} security checks passed`)
  if (failed.length) {
    console.log('FAILED: ' + failed.map((f) => f.name).join(' | '))
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('harness error:', e.message)
  process.exit(2)
})
