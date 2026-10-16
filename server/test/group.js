// Verifies the shared group session: host starts, all peers shoot together,
// every client receives every participant's frames, and composition is identical.
import { WebSocket } from 'ws'

const URL = process.env.SERVER_URL ?? 'ws://127.0.0.1:8787/ws'
const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL, { origin: 'http://localhost:5173' })
    ws.inbox = []
    ws.waiters = []
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'))
      const w = ws.waiters.shift()
      if (w) w(msg)
      else ws.inbox.push(msg)
    })
    ws.next = (timeoutMs = 3000) =>
      new Promise((res, rej) => {
        if (ws.inbox.length) return res(ws.inbox.shift())
        const t = setTimeout(() => rej(new Error('timeout')), timeoutMs)
        ws.waiters.push((m) => { clearTimeout(t); res(m) })
      })
    ws.drain = async (waitMs = 350) => {
      await sleep(waitMs)
      const out = ws.inbox.slice()
      ws.inbox.length = 0
      return out
    }
    ws.sendJson = (o) => ws.send(JSON.stringify(o))
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

const frame = (tag) => `data:image/jpeg;base64,${Buffer.from(`pose-${tag}`).toString('base64')}`

async function main() {
  // Host + two guests
  const host = await connect()
  host.sendJson({ type: 'create', hostName: 'Host', templateId: 'web-rush', roomSize: 4 })
  const created = await host.next()
  const code = created.code
  const prePhotoLead = created.room.prePhotoEndsAt - created.room.serverNow
  // Allow a little scheduler/clock granularity around the nominal 180 seconds.
  check('room has a three-minute pre-photo deadline', Number.isFinite(prePhotoLead) && prePhotoLead <= 181000 && prePhotoLead > 175000, `lead=${prePhotoLead}ms`)

  const g1 = await connect()
  g1.sendJson({ type: 'join', code, name: 'Nadia' })
  const j1 = await g1.next()
  check('invite-code joiner receives the same pre-photo deadline', j1.room.prePhotoEndsAt === created.room.prePhotoEndsAt)

  const g2 = await connect()
  g2.sendJson({ type: 'join', code, name: 'Raka' })
  await g2.next()

  const hostUpdates = await host.drain(850)
  check('three participants in room', hostUpdates.some((m) => m.type === 'peer:joined' && m.peers.length === 3))

  // --- Session start is host-only -----------------------------------------
  await g1.drain()
  g1.sendJson({ type: 'session:start', poses: 4 })
  const denied = await g1.drain(500)
  check('guest cannot start a shared session', denied.some((m) => m.type === 'error' && m.code === 'NOT_HOST'))

  // --- Host starts; everyone receives the same start signal ---------------
  await Promise.all([host.drain(), g1.drain(), g2.drain()])
  host.sendJson({ type: 'session:start', poses: 4, leadMs: 3000, intervalMs: 1500 })
  const [hStart, g1Start, g2Start] = await Promise.all([host.drain(500), g1.drain(500), g2.drain(500)])
  const pick = (msgs) => msgs.find((m) => m.type === 'session:start')
  const hs = pick(hStart), s1 = pick(g1Start), s2 = pick(g2Start)
  check('all participants receive session:start', Boolean(hs && s1 && s2))
  check('everyone gets the same sessionId', hs && s1 && s2 && hs.sessionId === s1.sessionId && s1.sessionId === s2.sessionId, `id=${hs?.sessionId?.slice(0, 8)}`)
  check('everyone gets the same startAt deadline', hs && s1 && s2 && hs.startAt === s1.startAt && s1.startAt === s2.startAt)
  check('poses count is broadcast', hs?.poses === 4, `poses=${hs?.poses}`)
  check('startAt is in the future relative to serverNow', hs && hs.startAt > hs.serverNow, `lead=${hs ? hs.startAt - hs.serverNow : '?'}ms`)
  check('session has a finite capture deadline', hs && Number.isFinite(hs.endAt) && hs.endAt > hs.startAt, `duration=${hs ? hs.endAt - hs.serverNow : '?'}ms`)

  // --- Wrong frame count is rejected --------------------------------------
  g1.sendJson({ type: 'session:frames', sessionId: s1.sessionId, frames: [frame('a')] })
  const wrong = await g1.drain(500)
  check('wrong frame count rejected', wrong.some((m) => m.type === 'error' && m.code === 'WRONG_FRAME_COUNT'))

  // --- Non-image frames are rejected --------------------------------------
  g1.sendJson({ type: 'session:frames', sessionId: s1.sessionId, frames: [frame('a'), frame('b'), frame('c'), 'javascript:alert(1)'] })
  const badImg = await g1.drain(500)
  check('non-image frame rejected', badImg.some((m) => m.type === 'error' && m.code === 'BAD_IMAGE'))

  // --- Stale session id is rejected ---------------------------------------
  g1.sendJson({ type: 'session:frames', sessionId: 'not-the-session', frames: [frame('a'), frame('b'), frame('c'), frame('d')] })
  const mismatch = await g1.drain(500)
  check('stale session id rejected', mismatch.some((m) => m.type === 'error' && m.code === 'SESSION_MISMATCH'))

  // --- Everyone submits; all frames fan out -------------------------------
  const hostFrames = ['h1', 'h2', 'h3', 'h4'].map(frame)
  const g1Frames = ['n1', 'n2', 'n3', 'n4'].map(frame)
  const g2Frames = ['r1', 'r2', 'r3', 'r4'].map(frame)

  await Promise.all([host.drain(), g1.drain(), g2.drain()])
  host.sendJson({ type: 'session:frames', sessionId: hs.sessionId, frames: hostFrames })
  g1.sendJson({ type: 'session:frames', sessionId: s1.sessionId, frames: g1Frames })
  g2.sendJson({ type: 'session:frames', sessionId: s2.sessionId, frames: g2Frames })

  const [hIn, g1In, g2In] = await Promise.all([host.drain(900), g1.drain(900), g2.drain(900)])

  const frameMsgs = (msgs) => msgs.filter((m) => m.type === 'session:frames')
  check('host receives all 3 participants frames', frameMsgs(hIn).length === 3, `got=${frameMsgs(hIn).length}`)
  check('guest1 receives all 3 participants frames', frameMsgs(g1In).length === 3, `got=${frameMsgs(g1In).length}`)
  check('guest2 receives all 3 participants frames', frameMsgs(g2In).length === 3, `got=${frameMsgs(g2In).length}`)

  // Every client must see the SAME set of frames, so the composed strip matches.
  const signature = (msgs) =>
    frameMsgs(msgs)
      .map((m) => `${m.name}:${m.frames.length}`)
      .sort()
      .join('|')
  const sigH = signature(hIn), sig1 = signature(g1In), sig2 = signature(g2In)
  check('all clients see an identical participant set', sigH === sig1 && sig1 === sig2, sigH)

  // Frames carry names so the strip can label each person.
  check('frames are attributed to the right person', frameMsgs(hIn).some((m) => m.name === 'Nadia') && frameMsgs(hIn).some((m) => m.name === 'Raka'))

  // --- session:complete fires once everyone is in -------------------------
  check('session:complete broadcast after last submit', hIn.some((m) => m.type === 'session:complete' && m.peerCount === 3), )
  check('guest also receives session:complete', g1In.some((m) => m.type === 'session:complete'))

  // --- Double submission is rejected --------------------------------------
  g1.sendJson({ type: 'session:frames', sessionId: s1.sessionId, frames: g1Frames })
  const dupe = await g1.drain(500)
  const dupeErr = dupe.find((m) => m.type === 'error')
  check('double submit rejected after session closed', Boolean(dupeErr), dupeErr?.code)

  // --- A brand new session can start immediately --------------------------
  host.sendJson({ type: 'session:start', poses: 4, leadMs: 2000, intervalMs: 1200 })
  const second = await host.drain(500)
  check('second session can start after completion', second.some((m) => m.type === 'session:start'), )

  // --- Host cancel ends the session for everyone --------------------------
  host.sendJson({ type: 'session:cancel' })
  const cancelled = await g1.drain(500)
  check('session:cancel reaches guests', cancelled.some((m) => m.type === 'session:cancel'))

  for (const ws of [host, g1, g2]) ws.close()
  await sleep(150)

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} group-session checks passed`)
  if (failed.length) {
    console.log('FAILED: ' + failed.map((f) => f.name).join(' | '))
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('harness error:', e.message)
  process.exit(2)
})
