// Typed WebSocket client for the photovirtu room server.
// The invite code is only ever held in memory for the lifetime of the tab.

export type PeerRole = 'host' | 'guest'

export type Peer = {
  id: string
  name: string
  role: PeerRole
  muted: boolean
  joinedAt: number
}

export type RoomState = {
  templateId: string
  capacity: number
  createdAt: number
  prePhotoEndsAt: number
  serverNow: number
  peers: Peer[]
}

export type SignalData = { sdp?: string; candidate?: unknown }

export type RoomEvent =
  | { type: 'open' }
  | { type: 'created'; code: string; hostToken: string; selfId: string; room: RoomState }
  | { type: 'joined'; selfId: string; isHost: boolean; room: RoomState }
  | { type: 'peers'; peers: Peer[] }
  | { type: 'room'; room: RoomState }
  | { type: 'signal'; from: string; data: SignalData }
  | { type: 'share'; from: string; name: string; templateId: string; image: string; at: number }
  | { type: 'sessionStart'; sessionId: string; poses: number; intervalMs: number; startAt: number; endAt: number; serverNow: number }
  | { type: 'sessionFrames'; sessionId: string; from: string; name: string; frames: string[] }
  | { type: 'sessionComplete'; sessionId: string; peerCount: number }
  | { type: 'sessionCancel'; reason: string }
  | { type: 'kicked'; reason: string }
  | { type: 'error'; code: string }
  | { type: 'close'; code: number; reason: string }

type Handler = (event: RoomEvent) => void

const RECONNECT_BASE_MS = 800
const RECONNECT_MAX_MS = 12000
const MAX_RECONNECT_ATTEMPTS = 6

export function defaultRoomUrl(): string {
  const fromEnv = import.meta.env?.VITE_ROOM_SERVER as string | undefined
  if (fromEnv) return fromEnv
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  // Same-origin WebSocket works through the production reverse proxy and avoids
  // mixed-content failures. Vite proxies /ws to :8787 during development.
  return `${proto}://${window.location.host}/ws`
}

export class RoomClient {
  private ws: WebSocket | null = null
  private handlers = new Set<Handler>()
  private url: string
  private attempts = 0
  private closedByUser = false
  private queue: string[] = []

  code: string | null = null
  hostToken: string | null = null
  selfId: string | null = null
  isHost = false

  constructor(url = defaultRoomUrl()) {
    this.url = url
  }

  on(handler: Handler) {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  private emit(event: RoomEvent) {
    for (const handler of this.handlers) handler(event)
  }

  private sendRaw(payload: unknown) {
    const data = JSON.stringify(payload)
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data)
    else this.queue.push(data)
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws

      ws.onopen = () => {
        this.attempts = 0
        for (const item of this.queue.splice(0)) ws.send(item)
        this.emit({ type: 'open' })
        resolve()
      }

      ws.onmessage = (event) => {
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(String(event.data))
        } catch {
          return
        }
        this.route(msg)
      }

      ws.onclose = (event) => {
        this.emit({ type: 'close', code: event.code, reason: event.reason })
        if (!this.closedByUser) this.scheduleReconnect()
      }

      ws.onerror = () => reject(new Error('SOCKET_ERROR'))
    })
  }

  // Transient network drops should not eject the user mid-session.
  private scheduleReconnect() {
    if (this.attempts >= MAX_RECONNECT_ATTEMPTS) return
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempts, RECONNECT_MAX_MS)
    this.attempts += 1
    window.setTimeout(() => {
      if (this.closedByUser) return
      this.connect()
        .then(() => {
          // Re-announce identity so the room roster stays accurate.
          if (this.code) this.sendRaw({ type: 'join', code: this.code, name: this.displayName, hostToken: this.hostToken })
        })
        .catch(() => this.scheduleReconnect())
    }, delay)
  }

  private route(msg: Record<string, unknown>) {
    switch (msg.type) {
      case 'created':
        this.code = String(msg.code)
        this.hostToken = String(msg.hostToken)
        this.selfId = String(msg.selfId)
        this.isHost = true
        this.emit({ type: 'created', code: this.code, hostToken: this.hostToken, selfId: this.selfId, room: msg.room as RoomState })
        break
      case 'joined':
        this.selfId = String(msg.selfId)
        this.isHost = Boolean(msg.isHost)
        this.emit({ type: 'joined', selfId: this.selfId, isHost: this.isHost, room: msg.room as RoomState })
        break
      case 'peer:joined':
      case 'peer:left':
      case 'peer:update':
        this.emit({ type: 'peers', peers: msg.peers as Peer[] })
        break
      case 'room:state':
        this.emit({ type: 'room', room: msg.room as RoomState })
        break
      case 'signal':
        this.emit({ type: 'signal', from: String(msg.from), data: msg.data as SignalData })
        break
      case 'share':
        this.emit({ type: 'share', from: String(msg.from), name: String(msg.name), templateId: String(msg.templateId), image: String(msg.image), at: Number(msg.at) })
        break
      case 'session:start':
        this.emit({ type: 'sessionStart', sessionId: String(msg.sessionId), poses: Number(msg.poses), intervalMs: Number(msg.intervalMs), startAt: Number(msg.startAt), endAt: Number(msg.endAt), serverNow: Number(msg.serverNow) })
        break
      case 'session:frames':
        this.emit({ type: 'sessionFrames', sessionId: String(msg.sessionId), from: String(msg.from), name: String(msg.name), frames: Array.isArray(msg.frames) ? msg.frames.map(String) : [] })
        break
      case 'session:complete':
        this.emit({ type: 'sessionComplete', sessionId: String(msg.sessionId), peerCount: Number(msg.peerCount) })
        break
      case 'session:cancel':
        this.emit({ type: 'sessionCancel', reason: String(msg.reason) })
        break
      case 'kicked':
        this.closedByUser = true
        this.emit({ type: 'kicked', reason: String(msg.reason) })
        break
      case 'error':
        this.emit({ type: 'error', code: String(msg.code) })
        break
      default:
        break
    }
  }

  displayName = 'Guest'

  async create(hostName: string, templateId: string, roomSize: number, slotToken?: string) {
    this.displayName = hostName
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) await this.connect()
    this.sendRaw({ type: 'create', hostName, templateId, roomSize, slotToken })
  }

  async join(code: string, name: string, hostToken?: string | null) {
    this.displayName = name
    this.code = code.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (hostToken) this.hostToken = hostToken
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) await this.connect()
    this.sendRaw({ type: 'join', code: this.code, name, hostToken: this.hostToken })
  }

  updateRoom(templateId: string, roomSize: number) {
    this.sendRaw({ type: 'room:update', templateId, roomSize })
  }

  setMuted(muted: boolean) {
    this.sendRaw({ type: 'self:mute', muted })
  }

  rename(name: string) {
    this.sendRaw({ type: 'self:rename', name })
  }

  kick(peerId: string) {
    this.sendRaw({ type: 'host:kick', peerId })
  }

  signal(target: string, data: SignalData) {
    this.sendRaw({ type: 'signal', target, data })
  }

  share(image: string) {
    this.sendRaw({ type: 'share', image })
  }

  startSession(poses: number, leadMs: number, intervalMs: number) {
    this.sendRaw({ type: 'session:start', poses, leadMs, intervalMs })
  }

  submitFrames(sessionId: string, frames: string[]) {
    this.sendRaw({ type: 'session:frames', sessionId, frames })
  }

  cancelSession() {
    this.sendRaw({ type: 'session:cancel' })
  }

  leave() {
    this.closedByUser = true
    this.sendRaw({ type: 'leave' })
    this.ws?.close(1000, 'user left')
    this.ws = null
    this.code = null
    this.selfId = null
    this.isHost = false
  }
}

export function describeError(code: string): string {
  switch (code) {
    case 'ROOM_NOT_FOUND':
      return 'Kode undangan tidak ditemukan. Cek lagi ya.'
    case 'ROOM_FULL':
      return 'Room sudah penuh.'
    case 'RATE_LIMITED':
      return 'Terlalu banyak percobaan. Tunggu sebentar.'
    case 'NOT_HOST':
      return 'Hanya host yang bisa melakukan ini.'
    case 'PEER_NOT_FOUND':
      return 'Peserta sudah tidak ada di room.'
    case 'CANNOT_KICK_SELF':
      return 'Tidak bisa mengeluarkan diri sendiri.'
    case 'IMAGE_TOO_LARGE':
      return 'Ukuran gambar terlalu besar.'
    case 'BAD_IMAGE':
      return 'Format gambar tidak didukung.'
    case 'ROOM_CAPACITY':
      return 'Server sedang penuh. Coba lagi nanti.'
    case 'SLOT_NOT_APPROVED':
      return 'Slot belum aktif. Selesaikan pembayaran QRIS dulu ya.'
    default:
      return `Terjadi kesalahan (${code}).`
  }
}
