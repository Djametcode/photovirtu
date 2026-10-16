// In-memory room registry. Rooms hold no PII and are keyed by a hash of the
// invite code, so the plaintext code only ever exists in the host's browser.
import { generateInviteCode, hashCode, newHostToken, safeEqual } from './security.js'

const ROOM_TTL_MS = 12 * 60 * 60 * 1000 // idle rooms expire after 12h
const MAX_ROOMS = 5000
const MAX_PEERS_PER_ROOM = 8
export const PRE_PHOTO_WAIT_MS = 3 * 60 * 1000

// hash -> room
const rooms = new Map()

export function sanitiseDisplayName(raw) {
  const cleaned = String(raw ?? '')
    .split('')
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code > 0x1f && code !== 0x7f
    })
    .join('') // strip control chars
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.slice(0, 24) || 'Guest'
}

export function createRoom({ templateId, roomSize, maxCapacity = MAX_PEERS_PER_ROOM }) {
  if (rooms.size >= MAX_ROOMS) throw new Error('ROOM_CAPACITY')

  // Retry on the astronomically unlikely hash collision.
  let code = ''
  let hash = ''
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateInviteCode()
    const candidateHash = hashCode(candidate)
    if (!rooms.has(candidateHash)) {
      code = candidate
      hash = candidateHash
      break
    }
  }
  if (!hash) throw new Error('CODE_GENERATION_FAILED')

  const room = {
    // NOTE: the plaintext code is intentionally NOT stored. It is returned to
    // the caller exactly once; after that only the SHA-256 hash remains.
    hash,
    hostToken: newHostToken(),
    templateId: templateId ?? 'web-rush',
    capacity: clampCapacity(roomSize),
    maxCapacity: clampCapacity(maxCapacity),
    createdAt: Date.now(),
    // Absolute server deadline for the pre-photo waiting screen.
    prePhotoEndsAt: Date.now() + PRE_PHOTO_WAIT_MS,
    lastActivity: Date.now(),
    peers: new Map(), // peerId -> peer
  }
  rooms.set(hash, room)
  return { room, code }
}

function clampCapacity(value) {
  const n = Number.parseInt(String(value ?? 4), 10)
  if (!Number.isFinite(n)) return 4
  return Math.min(Math.max(n, 2), MAX_PEERS_PER_ROOM)
}

// Constant-time membership check: we hash the provided code and look it up,
// so a wrong code reveals nothing beyond "not found".
export function findRoomByCode(rawCode) {
  const room = rooms.get(hashCode(rawCode))
  if (!room) return null
  room.lastActivity = Date.now()
  return room
}

export function isHost(room, token) {
  return Boolean(token) && safeEqual(room.hostToken, token)
}

export function addPeer(room, peer) {
  if (room.peers.size >= room.capacity) {
    // Display names are not identities. Never evict a participant merely
    // because a new connection claims the same name.
    return { ok: false, reason: 'ROOM_FULL' }
  }
  room.peers.set(peer.id, peer)
  room.lastActivity = Date.now()
  return { ok: true }
}

export function removePeer(room, peerId) {
  const removed = room.peers.delete(peerId)
  room.lastActivity = Date.now()
  return removed
}

export function publicPeers(room) {
  return [...room.peers.values()].map((peer) => ({
    id: peer.id,
    name: peer.name,
    role: peer.role,
    muted: peer.muted,
    joinedAt: peer.joinedAt,
  }))
}

export function publicRoom(room) {
  return {
    templateId: room.templateId,
    capacity: room.capacity,
    createdAt: room.createdAt,
    prePhotoEndsAt: room.prePhotoEndsAt,
    serverNow: Date.now(),
    peers: publicPeers(room),
  }
}

export function deleteRoom(room) {
  rooms.delete(room.hash)
}

export function roomCount() {
  return rooms.size
}

// Periodic maintenance: expire abandoned rooms so memory stays bounded.
export function sweepRooms(now = Date.now()) {
  for (const [hash, room] of rooms) {
    const empty = room.peers.size === 0
    const idle = now - room.lastActivity > ROOM_TTL_MS
    if (idle) rooms.delete(hash)
    else if (empty && now - room.lastActivity > 60 * 60 * 1000) rooms.delete(hash)
  }
}
