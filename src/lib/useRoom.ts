// Peer-to-peer media + room presence orchestration.
// Media never touches the server: only SDP/ICE are relayed.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RoomClient, describeError } from './roomClient'
import type { Peer, RoomEvent, RoomState, SignalData } from './roomClient'

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

export type RemoteStream = { peerId: string; name: string; stream: MediaStream }

function normaliseRoomClock(incoming: RoomState): RoomState {
  // Snapshot timing is server-clock based. Translate its remaining duration to
  // this device so a joiner never freezes because its wall clock differs.
  const remaining = Math.max(0, incoming.prePhotoEndsAt - incoming.serverNow)
  return { ...incoming, prePhotoEndsAt: Date.now() + remaining, serverNow: Date.now() }
}

export function useRoom() {
  const clientRef = useRef<RoomClient | null>(null)
  if (!clientRef.current) clientRef.current = new RoomClient()
  const client = clientRef.current

  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'closed'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [kicked, setKicked] = useState<string | null>(null)
  const [room, setRoom] = useState<RoomState | null>(null)
  const [selfId, setSelfId] = useState<string | null>(null)
  const [isHost, setIsHost] = useState(false)
  const [code, setCode] = useState<string | null>(null)
  const [remotes, setRemotes] = useState<RemoteStream[]>([])
  const [shares, setShares] = useState<{ from: string; name: string; image: string; at: number }[]>([])
  const [localStreamVersion, setLocalStreamVersion] = useState(0)
  // Shared group session: host broadcasts startAt (server clock), every client
  // converts to its own clock so the shutter fires at the same instant.
  const [session, setSession] = useState<{ sessionId: string; poses: number; intervalMs: number; startAt: number; endAt: number } | null>(null)
  const [sessionFrames, setSessionFrames] = useState<{ peerId: string; name: string; frames: string[] }[]>([])
  const [ownFrames, setOwnFrames] = useState<string[]>([])
  const [sessionComplete, setSessionComplete] = useState(false)
  const [countdown, setCountdown] = useState<number | null>(null)

  const localStreamRef = useRef<MediaStream | null>(null)
  const peersRef = useRef(new Map<string, RTCPeerConnection>())
  const pendingIceRef = useRef(new Map<string, RTCIceCandidateInit[]>())
  // Offers received before the camera was ready; replayed on attach so the
  // answer always carries local tracks.
  const pendingOffersRef = useRef(new Map<string, string>())

  const peers = useMemo(() => room?.peers ?? [], [room])

  const nameFor = useCallback(
    (id: string) => peers.find((p) => p.id === id)?.name ?? 'Teman',
    [peers],
  )

  const closePeer = useCallback((peerId: string) => {
    const pc = peersRef.current.get(peerId)
    if (pc) {
      pc.onicecandidate = null
      pc.ontrack = null
      pc.onconnectionstatechange = null
      pc.close()
      peersRef.current.delete(peerId)
    }
    pendingIceRef.current.delete(peerId)
    setRemotes((current) => current.filter((r) => r.peerId !== peerId))
  }, [])

  const attachTracks = useCallback((pc: RTCPeerConnection) => {
    const stream = localStreamRef.current
    if (!stream) return
    for (const track of stream.getTracks()) pc.addTrack(track, stream)
  }, [])

  // Deterministic offerer: the lexicographically smaller id initiates, so both
  // sides never create conflicting offers for the same pair.
  const shouldOffer = useCallback(
    (peerId: string) => Boolean(selfId) && selfId! < peerId,
    [selfId],
  )

  const getPeerConnection = useCallback(
    (peerId: string) => {
      const existing = peersRef.current.get(peerId)
      if (existing) return existing

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
      peersRef.current.set(peerId, pc)

      pc.onicecandidate = (event) => {
        if (!event.candidate) return
        client.signal(peerId, { candidate: event.candidate.toJSON() })
      }

      pc.ontrack = (event) => {
        const [stream] = event.streams
        if (!stream) return
        setRemotes((current) => {
          const rest = current.filter((r) => r.peerId !== peerId)
          return [...rest, { peerId, name: nameFor(peerId), stream }]
        })
      }

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePeer(peerId)
      }

      return pc
    },
    [client, closePeer, nameFor],
  )

  const debugCounters = useRef({ errors: [] as string[] })

  const makeOffer = useCallback(
    async (peerId: string) => {
      try {
        // Without a local stream the SDP carries no m-line, so ICE never starts
        // and the connection sits in 'new' forever. Never negotiate before the
        // camera is attached.
        if (!localStreamRef.current) return
        const pc = getPeerConnection(peerId)
        attachTracks(pc)
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        client.signal(peerId, { sdp: offer.sdp })
      } catch (error) {
        debugCounters.current.errors.push(`offer:${(error as Error).message}`)
      }
    },
    [attachTracks, client, getPeerConnection],
  )

  async function handleSignal(from: string, data: SignalData) {
    try {
      const pc = getPeerConnection(from)
      if (data.sdp) {
        // sdp-only payload: decide offer vs answer by current signalling state.
        const description: RTCSessionDescriptionInit = { type: pc.signalingState === 'have-local-offer' ? 'answer' : 'offer', sdp: data.sdp }
        if (description.type === 'offer' && pc.signalingState === 'stable' && shouldOffer(from)) {
          // Both sides tried to offer; the designated offerer keeps its own.
          return
        }
        // An answer built without local tracks is permanently track-less. If the
        // camera is not ready yet, park the offer and replay it once it is.
        if (description.type === 'offer' && !localStreamRef.current) {
          pendingOffersRef.current.set(from, data.sdp)
          return
        }
        await pc.setRemoteDescription(description)
        if (description.type === 'offer') {
          attachTracks(pc)
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          client.signal(from, { sdp: answer.sdp })
        }
        const queued = pendingIceRef.current.get(from) ?? []
        pendingIceRef.current.delete(from)
        for (const candidate of queued) await pc.addIceCandidate(candidate)
      } else if (data.candidate) {
        const candidate = data.candidate as RTCIceCandidateInit
        if (pc.remoteDescription) await pc.addIceCandidate(candidate)
        else {
          const queued = pendingIceRef.current.get(from) ?? []
          queued.push(candidate)
          pendingIceRef.current.set(from, queued)
        }
      }
    } catch {
      // A failed negotiation for one peer must not break the rest of the room.
      closePeer(from)
    }
  }

  // The subscription effect below must not capture stale closures: selfId,
  // peers and the negotiation helpers all change across renders. Keep a ref to
  // the newest handler and dispatch through it.
  const handlerRef = useRef<(event: RoomEvent) => void>(() => {})
  // handleSignal is redefined each render (it closes over the latest selfId),
  // so route it through a ref instead of making it a useCallback dependency.
  const signalHandlerRef = useRef(handleSignal)
  signalHandlerRef.current = handleSignal

  const onRoomEvent = useCallback((event: RoomEvent) => {
    switch (event.type) {
      case 'open':
        setStatus('connected')
        break
      case 'created':
        setCode(event.code)
        setSelfId(event.selfId)
        setIsHost(true)
        setRoom(normaliseRoomClock(event.room))
        break
      case 'joined':
        setSelfId(event.selfId)
        setIsHost(event.isHost)
        setRoom(normaliseRoomClock(event.room))
        break
      case 'peers':
        setRoom((current) => (current ? { ...current, peers: event.peers } : current))
        break
      case 'room':
        setRoom(normaliseRoomClock(event.room))
        break
      case 'signal':
        void signalHandlerRef.current(event.from, event.data)
        break
      case 'share':
        setShares((current) => [{ from: event.from, name: event.name, image: event.image, at: event.at }, ...current].slice(0, 12))
        break
      case 'sessionStart': {
        // serverNow and startAt are both server-clock values. Their difference is
        // the true lead time; applying it to the local clock removes drift
        // without needing a round-trip estimate.
        const lead = Math.max(0, event.startAt - event.serverNow)
        const sessionDuration = Math.max(0, event.endAt - event.startAt)
        const localStartAt = Date.now() + lead
        setSession({ sessionId: event.sessionId, poses: event.poses, intervalMs: event.intervalMs, startAt: localStartAt, endAt: localStartAt + sessionDuration })
        setSessionFrames([])
        setOwnFrames([])
        setSessionComplete(false)
        setCountdown(Math.ceil(lead / 1000))
        break
      }
      case 'sessionFrames':
        setSessionFrames((current) => {
          const rest = current.filter((p) => p.peerId !== event.from)
          return [...rest, { peerId: event.from, name: event.name, frames: event.frames }]
        })
        break
      case 'sessionComplete':
        setCountdown(null)
        setSessionComplete(true)
        break
      case 'sessionCancel':
        setSession(null)
        setSessionFrames([])
        setOwnFrames([])
        setSessionComplete(false)
        setCountdown(null)
        break
      case 'kicked':
        setKicked(event.reason === 'host_left' ? 'Host menutup room, sesi berakhir.' : 'Kamu dikeluarkan dari room oleh host.')
        setStatus('closed')
        setRoom(null)
        setRemotes([])
        break
      case 'error':
        setError(describeError(event.code))
        break
      case 'close':
        setStatus((s) => (s === 'closed' ? s : 'connecting'))
        break
      default:
        break
    }
  }, [])

  handlerRef.current = onRoomEvent

  useEffect(() => {
    const off = client.on((event: RoomEvent) => handlerRef.current(event))
    return () => {
      off()
    }
    // Only the client identity matters; dispatch goes through handlerRef.
  }, [client])

  // When the roster changes, negotiate with peers we have no connection to yet.
  // localStreamVersion is a dependency so this re-runs once the camera exists.
  useEffect(() => {
    if (!selfId) return
    const ids = new Set(peers.map((p) => p.id).filter((id) => id !== selfId))
    for (const id of ids) {
      if (!peersRef.current.has(id) && shouldOffer(id)) void makeOffer(id)
    }
    for (const existing of [...peersRef.current.keys()]) {
      if (!ids.has(existing)) closePeer(existing)
    }
  }, [peers, selfId, shouldOffer, makeOffer, closePeer, localStreamVersion])

  // Drive the shared countdown from the absolute local deadline. This must be
  // an interval, not a state-dependent timeout: the first 250ms tick often
  // computes the same number (for example 4 → 4), which React correctly skips
  // rendering and would otherwise leave a one-shot countdown frozen.
  useEffect(() => {
    if (!session) return
    const updateCountdown = () => {
      const remaining = Math.max(0, Math.ceil((session.startAt - Date.now()) / 1000))
      setCountdown(remaining)
    }
    updateCountdown()
    const timer = window.setInterval(updateCountdown, 200)
    return () => window.clearInterval(timer)
  }, [session])

  const attachLocalStream = useCallback((stream: MediaStream | null) => {
    localStreamRef.current = stream
    // Replay any offer that arrived before the camera was ready; only now can we
    // answer with real tracks attached.
    if (stream && pendingOffersRef.current.size) {
      const parked = [...pendingOffersRef.current.entries()]
      pendingOffersRef.current.clear()
      // Use the ref so we always call the latest handleSignal (it closes over
      // the current selfId), never the first render's stale copy.
      for (const [from, sdp] of parked) void signalHandlerRef.current(from, { sdp })
    }
    // Signals the negotiation effect to (re)run now that tracks exist.
    setLocalStreamVersion((v) => v + 1)
    // handleSignal closes over refs and state setters only, so this is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const create = useCallback(
    (hostName: string, templateId: string, roomSize: number, slotToken?: string) => {
      setError(null)
      setStatus('connecting')
      void client.create(hostName, templateId, roomSize, slotToken)
    },
    [client],
  )

  const join = useCallback(
    (inviteCode: string, name: string, hostToken?: string | null) => {
      setError(null)
      setStatus('connecting')
      void client.join(inviteCode, name, hostToken)
    },
    [client],
  )

  const leave = useCallback(() => {
    for (const id of [...peersRef.current.keys()]) closePeer(id)
    client.leave()
    setStatus('closed')
    setRoom(null)
    setShares([])
    setError(null)
    setKicked(null)
  }, [client, closePeer])

  const setMuted = useCallback((muted: boolean) => {
    // Keep the media and roster state in sync: muting must disable the actual
    // outgoing microphone track, not merely change the label in the UI.
    for (const track of localStreamRef.current?.getAudioTracks() ?? []) track.enabled = !muted
    client.setMuted(muted)
  }, [client])

  // Debug surface for automated tests; not used by the UI.
  const debugState = useCallback(() => ({
    selfId,
    status,
    peers: peers.map((p) => ({ id: p.id, role: p.role, name: p.name })),
    connections: [...peersRef.current.entries()].map(([id, pc]) => ({ id, state: pc.connectionState, signaling: pc.signalingState })),
    remotes: remotes.map((r) => ({ peerId: r.peerId, tracks: r.stream.getVideoTracks().length })),
  }), [selfId, status, peers, remotes])

  // Always release camera and peer connections on unmount. Capture the ref
  // objects now: their .current may be reassigned by the time cleanup runs.
  useEffect(() => {
    const peers = peersRef.current
    return () => {
      for (const pc of peers.values()) pc.close()
      peers.clear()
      const stream = localStreamRef.current
      stream?.getTracks().forEach((t) => t.stop())
      localStreamRef.current = null
      client.leave()
    }
  }, [client])

  return {
    status,
    error,
    kicked,
    setError,
    clearKicked: () => setKicked(null),
    debugState,
    room,
    peers,
    selfId,
    isHost,
    code,
    remotes,
    shares,
    session,
    sessionFrames,
    ownFrames,
    setOwnFrames,
    sessionComplete,
    countdown,
    create,
    join,
    leave,
    attachLocalStream,
    signal: client.signal.bind(client),
    setMuted,
    rename: client.rename.bind(client),
    kick: client.kick.bind(client),
    updateRoom: client.updateRoom.bind(client),
    share: client.share.bind(client),
    startSession: client.startSession.bind(client),
    submitFrames: client.submitFrames.bind(client),
    cancelSession: client.cancelSession.bind(client),
  }
}

export type RoomApi = ReturnType<typeof useRoom>
export type { Peer }
