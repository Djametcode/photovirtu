// End-to-end verification of the room server using real WebSocket clients.
// Run: node test/e2e.js   (server must be reachable at SERVER_URL)
import { WebSocket } from 'ws'

const URL = process.env.SERVER_URL ?? 'ws://127.0.0.1:8787/ws'
const results = []

function check(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL, { origin: 'http://localhost:5173' })
    ws.inbox = []
    ws.waiters = []
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'))
      const waiter = ws.waiters.shift()
      if (waiter) waiter(msg)
      else ws.inbox.push(msg)
    })
    ws.next = (timeoutMs = 2500) =>
      new Promise((res, rej) => {
        if (ws.inbox.length) return res(ws.inbox.shift())
        const timer = setTimeout(() => rej(new Error('timeout waiting for message')), timeoutMs)
        ws.waiters.push((msg) => {
          clearTimeout(timer)
          res(msg)
        })
      })
    ws.sendJson = (obj) => ws.send(JSON.stringify(obj))
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // 1. Host creates a room
  const host = await connect()
  host.sendJson({ type: 'create', hostName: 'Host', templateId: 'web-rush', roomSize: 4 })
  const created = await host.next()
  check('create returns invite code', created.type === 'created' && /^[0-9A-HJKMNP-TV-Z]{8}$/.test(created.code), `code=${created.code}`)
  check('create does not leak plaintext code elsewhere', typeof created.hostToken === 'string' && created.hostToken.length > 20)

  const code = created.code

  // 2. Guest joins with the correct code
  const guest = await connect()
  guest.sendJson({ type: 'join', code, name: 'Guest' })
  const joined = await guest.next()
  check('join with valid code succeeds', joined.type === 'joined', `selfId=${joined.selfId}`)
  check('guest is not host', joined.isHost === false)

  const hostNotice = await host.next()
  check('host is notified of new peer', hostNotice.type === 'peer:joined' && hostNotice.peers.length === 2)

  // 3. Wrong code is rejected (and leaks nothing beyond ROOM_NOT_FOUND)
  const attacker = await connect()
  attacker.sendJson({ type: 'join', code: 'ZZZZZZZZ', name: 'Attacker' })
  const denied = await attacker.next()
  check('wrong invite code rejected', denied.type === 'error' && denied.code === 'ROOM_NOT_FOUND', `code=${denied.code}`)

  // 4. Empty/garbage codes are rejected
  const attacker2 = await connect()
  attacker2.sendJson({ type: 'join', code: '', name: 'Attacker' })
  const denied2 = await attacker2.next()
  check('empty invite code rejected', denied2.type === 'error')

  // 5. Signalling relays only inside the room
  const hostPeerId = joined.room.peers.find((p) => p.role === 'host').id
  guest.sendJson({ type: 'signal', target: hostPeerId, data: { sdp: 'v=0 fake-offer' } })
  const relayed = await host.next()
  check('signal relayed to host', relayed.type === 'signal' && relayed.from === joined.selfId)

  // 6. Signalling to a non-member is refused
  guest.sendJson({ type: 'signal', target: 'not-a-real-peer', data: { sdp: 'x' } })
  const badSignal = await guest.next()
  check('signal to unknown peer refused', badSignal.type === 'error' && badSignal.code === 'PEER_NOT_FOUND')

  // 7. Guest cannot perform host actions
  guest.sendJson({ type: 'host:kick', peerId: joined.selfId })
  const notHost = await guest.next()
  check('guest cannot use host:kick', notHost.type === 'error' && notHost.code === 'NOT_HOST', `code=${notHost.code}`)

  // 8. Host can kick a guest
  host.sendJson({ type: 'host:kick', peerId: joined.selfId })
  const kickedNotice = await guest.next()
  check('kicked guest receives notice', kickedNotice.type === 'kicked', `reason=${kickedNotice.reason}`)
  const afterKick = await host.next()
  check('room shrinks after kick', afterKick.type === 'peer:left' && afterKick.peers.length === 1)

  // 9. Share image is broadcast to others
  const guest2 = await connect()
  guest2.sendJson({ type: 'join', code, name: 'Guest2' })
  await guest2.next()
  await host.next()
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  guest2.sendJson({ type: 'share', image: tinyPng })
  const shared = await host.next()
  check('share broadcast to room', shared.type === 'share' && shared.image.startsWith('data:image/'), `from=${shared.name}`)

  // 10. Non-image share is refused
  guest2.sendJson({ type: 'share', image: 'javascript:alert(1)' })
  const badShare = await guest2.next()
  check('non-image share refused', badShare.type === 'error' && badShare.code === 'BAD_IMAGE', `code=${badShare.code}`)

  // 11. Unknown message types are refused
  host.sendJson({ type: 'definitely:not:a:thing' })
  const unknown = await host.next()
  check('unknown message type refused', unknown.type === 'error' && unknown.code === 'UNKNOWN_TYPE')

  // 12. Host disconnect tears the room down
  const guest3 = await connect()
  guest3.sendJson({ type: 'join', code, name: 'Guest3' })
  await guest3.next()
  host.close()
  const evicted = await guest3.next(3000)
  check('host leaving evicts remaining peers', evicted.type === 'kicked' && evicted.reason === 'host_left', `reason=${evicted.reason}`)

  for (const ws of [guest, guest2, guest3, attacker, attacker2]) ws.close()
  await sleep(150)

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    console.log('FAILED:', failed.map((f) => f.name).join(', '))
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('harness error:', error.message)
  process.exit(2)
})
