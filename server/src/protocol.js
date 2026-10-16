// Message protocol for a connected socket.
// Security posture:
//  - join requires a valid invite code and is rate-limited by the caller
//  - host-only actions require the host capability token
//  - every message is validated against a strict allowlist before use
//  - relayed signalling is addressed only to peers inside the same room
import { newPeerId } from './security.js'
import { activateOrder, restoreOrder } from './store/orders.js'
import {
  addPeer,
  createRoom,
  deleteRoom,
  findRoomByCode,
  isHost,
  publicPeers,
  publicRoom,
  removePeer,
  sanitiseDisplayName,
} from './rooms.js'

const MAX_SDP_LENGTH = 20000
// Per-pose JPEG budget. Four of these plus base64 overhead stays inside the
// 2 MB transport frame while keeping a full-resolution capture.
const MAX_FRAME_BYTES = 380000
const RECONNECT_SWEEP_MS = 5 * 60 * 1000
const AUTO_SESSION_LEAD_MS = 4000
const AUTO_SESSION_POSES = 4
const AUTO_SESSION_INTERVAL_MS = 2600

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload))
}

function broadcast(room, payload, exceptPeerId = null) {
  const data = JSON.stringify(payload)
  for (const peer of room.peers.values()) {
    if (peer.id === exceptPeerId) continue
    if (peer.ws.readyState === peer.ws.OPEN) peer.ws.send(data)
  }
}

function requireRoom(ws) {
  if (!ws.room || !ws.peer) throw new Error('NOT_IN_ROOM')
  return ws.room
}

function requireHost(ws) {
  const room = requireRoom(ws)
  if (!isHost(room, ws.hostToken)) throw new Error('NOT_HOST')
  return room
}

function clearSessionTimeout(room) {
  clearTimeout(room.sessionTimeout)
  room.sessionTimeout = null
}

function startSession(room, { startedBy, poses = AUTO_SESSION_POSES, leadMs = AUTO_SESSION_LEAD_MS, intervalMs = AUTO_SESSION_INTERVAL_MS }) {
  if (room.session) return false
  clearTimeout(room.prePhotoTimeout)
  room.prePhotoTimeout = null
  const safePoses = Math.min(Math.max(Number.isFinite(poses) ? poses : 4, 1), 6)
  const safeIntervalMs = Math.min(Math.max(Number.isFinite(intervalMs) ? intervalMs : 2500, 1200), 10000)
  const serverNow = Date.now()
  const startAt = serverNow + Math.min(Math.max(Number.isFinite(leadMs) ? leadMs : 3000, 1500), 15000)
  const session = {
    id: newPeerId(),
    startedBy,
    poses: safePoses,
    intervalMs: safeIntervalMs,
    serverNow,
    startAt,
    // The 3-minute limit governs the waiting room. A photo round ends after
    // its actual pose window plus a short upload grace period.
    endAt: startAt + safePoses * safeIntervalMs + 15_000,
    submitted: new Set(),
    frames: new Map(),
  }
  room.session = session
  room.sessionTimeout = setTimeout(() => {
    if (room.session?.id !== session.id) return
    room.session = null
    room.sessionTimeout = null
    broadcast(room, { type: 'session:cancel', reason: 'session_timeout' })
  }, Math.max(0, session.endAt - Date.now()))
  room.sessionTimeout.unref?.()
  broadcast(room, {
    type: 'session:start',
    sessionId: session.id,
    poses: session.poses,
    intervalMs: session.intervalMs,
    serverNow: session.serverNow,
    startAt: session.startAt,
    endAt: session.endAt,
  })
  return true
}

export function attachPeer(ws, message, deps) {
  const type = message?.type

  if (type === 'create') {
    if (!deps.joinLimiter(ws.ip)) throw new Error('RATE_LIMITED')

    // A paid slot is a one-use capability: it is atomically transitioned from
    // APPROVED to ACTIVATED before any room state is allocated, so one payment
    // can never open two rooms. Portable rooms (payments disabled) pass null.
    const slot = deps.requirePayment ? activateOrder(message.slotToken) : null
    let created
    try {
      created = createRoom({
        templateId: message.templateId,
        roomSize: slot?.capacity ?? message.roomSize,
        maxCapacity: slot?.capacity ?? 8,
      })
    } catch (error) {
      if (slot) restoreOrder(message.slotToken)
      throw error
    }
    const { room, code } = created
    const peer = {
      id: newPeerId(),
      ws,
      name: sanitiseDisplayName(message.hostName),
      role: 'host',
      muted: false,
      joinedAt: Date.now(),
    }
    addPeer(room, peer)
    room.prePhotoTimeout = setTimeout(() => {
      room.prePhotoTimeout = null
      // Server starts the shared photo round at the room deadline. Invite-code
      // guests receive the same broadcast and cannot forge this transition.
      startSession(room, { startedBy: peer.id })
    }, Math.max(0, room.prePhotoEndsAt - Date.now()))
    room.prePhotoTimeout.unref?.()
    ws.room = room
    ws.peer = peer
    ws.hostToken = room.hostToken
    ws.cleanup = () => handleDisconnect(ws)
    send(ws, { type: 'created', code, hostToken: room.hostToken, selfId: peer.id, room: publicRoom(room) })
    return
  }

  if (type === 'join') {
    if (!deps.joinLimiter(ws.ip)) throw new Error('RATE_LIMITED')
    const room = findRoomByCode(message.code)
    if (!room) throw new Error('ROOM_NOT_FOUND')
    const peer = {
      id: newPeerId(),
      ws,
      name: sanitiseDisplayName(message.name),
      role: 'guest',
      muted: false,
      joinedAt: Date.now(),
    }
    const added = addPeer(room, peer)
    if (!added.ok) throw new Error(added.reason)
    ws.room = room
    ws.peer = peer
    ws.hostToken = typeof message.hostToken === 'string' ? message.hostToken : null
    ws.cleanup = () => handleDisconnect(ws)
    send(ws, { type: 'joined', selfId: peer.id, isHost: isHost(room, ws.hostToken), room: publicRoom(room) })
    broadcast(room, { type: 'peer:joined', peers: publicPeers(room) }, peer.id)
    return
  }

  if (type === 'room:update') {
    const room = requireHost(ws)
    if (typeof message.templateId === 'string') room.templateId = message.templateId.slice(0, 40)
    if (message.roomSize !== undefined) {
      const size = Number.parseInt(String(message.roomSize), 10)
      if (Number.isFinite(size)) room.capacity = Math.min(Math.max(size, room.peers.size, 2), room.maxCapacity)
    }
    broadcast(room, { type: 'room:state', room: publicRoom(room) })
    return
  }

  if (type === 'self:mute') {
    const room = requireRoom(ws)
    ws.peer.muted = Boolean(message.muted)
    broadcast(room, { type: 'peer:update', peers: publicPeers(room) })
    return
  }

  if (type === 'self:rename') {
    const room = requireRoom(ws)
    ws.peer.name = sanitiseDisplayName(message.name)
    broadcast(room, { type: 'peer:update', peers: publicPeers(room) })
    return
  }

  if (type === 'host:kick') {
    const room = requireHost(ws)
    const targetId = String(message.peerId ?? '')
    if (targetId === ws.peer.id) throw new Error('CANNOT_KICK_SELF')
    const target = room.peers.get(targetId)
    if (!target) throw new Error('PEER_NOT_FOUND')
    send(target.ws, { type: 'kicked', reason: 'host_removed' })
    removePeer(room, targetId)
    target.ws.room = null
    target.ws.peer = null
    broadcast(room, { type: 'peer:left', peers: publicPeers(room) })
    return
  }

  if (type === 'session:start') {
    // Only the host can manually advance the room before the 3-minute deadline.
    const room = requireHost(ws)
    const poses = Number.parseInt(String(message.poses ?? 4), 10)
    const leadMs = Number.parseInt(String(message.leadMs ?? 3000), 10)
    const intervalMs = Number.parseInt(String(message.intervalMs ?? 2500), 10)
    startSession(room, { startedBy: ws.peer.id, poses, leadMs, intervalMs })
    return
  }

  if (type === 'session:frames') {
    const room = requireRoom(ws)
    const session = room.session
    if (!session) throw new Error('NO_SESSION')
    if (Date.now() > session.endAt) {
      clearSessionTimeout(room)
      room.session = null
      broadcast(room, { type: 'session:cancel', reason: 'session_timeout' })
      throw new Error('SESSION_TIMEOUT')
    }
    if (String(message.sessionId ?? '') !== session.id) throw new Error('SESSION_MISMATCH')
    if (session.submitted.has(ws.peer.id)) throw new Error('ALREADY_SUBMITTED')

    // Validate BEFORE consuming rate-limit budget. A malformed request must be
    // rejected on its merits, not silently burn the quota that a legitimate
    // submission needs.
    const frames = Array.isArray(message.frames) ? message.frames : []
    if (frames.length !== session.poses) throw new Error('WRONG_FRAME_COUNT')
    for (const frame of frames) {
      if (typeof frame !== 'string' || !frame.startsWith('data:image/')) throw new Error('BAD_IMAGE')
      if (frame.length > MAX_FRAME_BYTES) throw new Error('IMAGE_TOO_LARGE')
    }

    if (!deps.sessionLimiter(ws.ip)) throw new Error('RATE_LIMITED')

    session.submitted.add(ws.peer.id)
    session.frames.set(ws.peer.id, frames)
    broadcast(room, {
      type: 'session:frames',
      sessionId: session.id,
      from: ws.peer.id,
      name: ws.peer.name,
      frames,
    })

    if (session.submitted.size >= room.peers.size) {
      // Everyone is in: tell clients to compose, then clear so the host can
      // immediately start another round without stale frames leaking into it.
      broadcast(room, { type: 'session:complete', sessionId: session.id, peerCount: session.submitted.size })
      clearSessionTimeout(room)
      room.session = null
    }
    return
  }

  if (type === 'session:cancel') {
    const room = requireHost(ws)
    clearSessionTimeout(room)
    room.session = null
    broadcast(room, { type: 'session:cancel', reason: 'host_cancelled' })
    return
  }

  if (type === 'signal') {
    const room = requireRoom(ws)
    const targetId = String(message.target ?? '')
    // Relay only to a peer that is genuinely in the same room. This prevents
    // using the server to inject signalling into unrelated sessions.
    const target = room.peers.get(targetId)
    if (!target) throw new Error('PEER_NOT_FOUND')
    const data = message.data
    if (!data || typeof data !== 'object') throw new Error('BAD_SIGNAL')
    if (data.sdp !== undefined && String(data.sdp).length > MAX_SDP_LENGTH) throw new Error('SIGNAL_TOO_LARGE')
    if (typeof data.sdp !== 'string' && typeof data.candidate !== 'object' && typeof data.candidate !== 'string') {
      throw new Error('BAD_SIGNAL')
    }
    send(target.ws, { type: 'signal', from: ws.peer.id, data })
    return
  }

  if (type === 'share') {
    // A peer dropped its finished photostrip into the room. Payload is a
    // data URL capped by MAX_PAYLOAD_BYTES at the transport layer.
    const room = requireRoom(ws)
    if (!deps.shareLimiter(ws.ip)) throw new Error('RATE_LIMITED')
    const image = typeof message.image === 'string' ? message.image : ''
    if (!image.startsWith('data:image/')) throw new Error('BAD_IMAGE')
    if (image.length > 1500000) throw new Error('IMAGE_TOO_LARGE')
    broadcast(room, {
      type: 'share',
      from: ws.peer.id,
      name: ws.peer.name,
      templateId: room.templateId,
      image,
      at: Date.now(),
    }, ws.peer.id)
    return
  }

  if (type === 'leave') {
    handleDisconnect(ws)
    return
  }

  throw new Error('UNKNOWN_TYPE')
}

export function handleDisconnect(ws) {
  const room = ws.room
  const peer = ws.peer
  ws.room = null
  ws.peer = null
  if (!room || !peer) return
  removePeer(room, peer.id)

  // Host leaving closes the room: evict everyone first so no session is left
  // without a moderator, and so peers get a single unambiguous 'kicked'.
  if (peer.role === 'host') {
    clearSessionTimeout(room)
    clearTimeout(room.prePhotoTimeout)
    room.prePhotoTimeout = null
    for (const other of [...room.peers.values()]) {
      send(other.ws, { type: 'kicked', reason: 'host_left' })
      other.ws.room = null
      other.ws.peer = null
    }
    room.peers.clear()
    deleteRoom(room)
    return
  }

  broadcast(room, { type: 'peer:left', peers: publicPeers(room), leftId: peer.id })
  if (room.peers.size === 0) {
    clearSessionTimeout(room)
    clearTimeout(room.prePhotoTimeout)
    room.prePhotoTimeout = null
    deleteRoom(room)
  }
}

export { RECONNECT_SWEEP_MS }
