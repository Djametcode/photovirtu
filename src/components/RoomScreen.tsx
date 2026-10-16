// Live room: local camera + every connected peer's P2P video, roster, controls.
import { useEffect, useRef, useState } from 'react'
import type { RoomApi } from '../lib/useRoom'
import type { PhotoTemplate } from '../templates'
import { PeerVideo } from './PeerVideo'
import { cameraErrorMessage, cameraSupported } from '../lib/camera'
import { readableOn } from '../lib/contrast'

type Props = {
  template: PhotoTemplate
  room: RoomApi
  onStartSession: () => void
  onExit: () => void
}

export function RoomScreen({ template, room, onStartSession, onExit }: Props) {
  const { peers, selfId, isHost, remotes, code } = room
  const t = template.theme
  // Theme accents are decorative; labels and CTAs need AA on their real surface.
  const labelColor = readableOn(t.accent, t.panel)
  const onAccent = readableOn(t.onAccent, t.accent)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [copied, setCopied] = useState(false)
  const [muted, setMuted] = useState(false)
  const [waitSeconds, setWaitSeconds] = useState<number | null>(null)
  const [camError, setCamError] = useState<string | null>(null)
  const [camRetry, setCamRetry] = useState(0)

  // Countdown is driven from the absolute deadline received with the room
  // snapshot. It runs independently for hosts and invite-code joiners.
  useEffect(() => {
    const deadline = room.room?.prePhotoEndsAt
    if (!deadline) {
      setWaitSeconds(null)
      return
    }
    const update = () => setWaitSeconds(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)))
    update()
    const timer = window.setInterval(update, 200)
    return () => window.clearInterval(timer)
  }, [room.room?.prePhotoEndsAt])

  // Local camera is owned here and handed to useRoom for peer negotiation.
  useEffect(() => {
    let stream: MediaStream | null = null
    let cancelled = false
    if (!cameraSupported()) {
      setCamError(cameraErrorMessage(null))
      return
    }
    setCamError(null)
    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: 'user' },
        // Waiting room is also the call room. Include the mic before WebRTC
        // negotiates so every peer gets an audio m-line and can talk directly.
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((tr) => tr.stop())
          return
        }
        stream = s
        setCamError(null)
        room.attachLocalStream(s)
        if (videoRef.current) videoRef.current.srcObject = s
      })
      .catch((err) => {
        if (!cancelled) setCamError(cameraErrorMessage(err))
      })
    return () => {
      cancelled = true
      stream?.getTracks().forEach((tr) => tr.stop())
      room.attachLocalStream(null)
    }
    // Re-run when the user retries after granting permission.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camRetry])

  const toggleMute = () => {
    const next = !muted
    setMuted(next)
    room.setMuted(next)
  }

  const copyCode = async () => {
    if (!code) return
    try {
      await navigator.clipboard?.writeText(code)
    } catch {
      // Clipboard may be blocked; the code is still visible on screen.
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const others = peers.filter((p) => p.id !== selfId)

  // Test hook: lets the e2e harness inspect real WebRTC state.
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__photovirtuDebug = room.debugState
  }, [room.debugState])

  return (
    <main className="room-page" style={{ background: t.bg, color: t.ink }}>
      <header className="room-header">
        <button onClick={onExit}>← Keluar</button>
        <span className="room-live" role="status" aria-atomic="true"><i style={{ background: t.accent }} /> {peers.length} orang di room</span>
        <span className="room-template">{template.name}</span>
      </header>

      <div className="room-layout">
        <section className="room-stage">
          <div className={`peer-grid count-${Math.min(peers.length, 4)}`}>
            <div className="peer-tile">
              <video ref={videoRef} autoPlay muted playsInline className="mirror" />
              <div className="peer-scrim" />
              <span className="peer-name" style={{ borderColor: t.accent }}>Kamu{muted ? ' · mic off' : ''}</span>
              {camError && (
                <div className="cam-block" role="alert">
                  <p className="cam-block-msg">{camError}</p>
                  <button className="cam-block-retry" onClick={() => setCamRetry((n) => n + 1)}>
                    Coba lagi
                  </button>
                </div>
              )}
            </div>
            {remotes.map((remote) => (
              <PeerVideo
                key={remote.peerId}
                stream={remote.stream}
                name={peers.find((p) => p.id === remote.peerId)?.name ?? 'Teman'}
                accent={t.accent}
                muted={false}
              />
            ))}
          </div>

          {others.length > remotes.length && (
            <p className="room-status" style={{ color: t.line }}>
              Menghubungkan {others.length - remotes.length} peserta…
            </p>
          )}
        </section>

        <aside className="room-panel" style={{ background: t.panel, borderColor: t.line }}>
          <div className="panel-block">
            <p className="panel-label" style={{ color: labelColor }}>KODE UNDANGAN</p>
            <div className="code-row">
              <span className="code-value">{code ?? '—'}</span>
              <button onClick={copyCode} style={{ background: t.accent, color: t.onAccent }}>
                {copied ? 'Tersalin' : 'Salin'}
              </button>
            </div>
            <p className="panel-hint">Bagikan 8 karakter ini supaya teman bisa masuk.</p>
          </div>

          <div className="waiting-countdown" aria-live="polite" style={{ borderColor: t.line, background: t.bg }}>
            <span>MENUNGGU TEMAN</span>
            <strong>{waitSeconds === null ? '—' : `${String(Math.floor(waitSeconds / 60)).padStart(2, '0')}:${String(waitSeconds % 60).padStart(2, '0')}`}</strong>
            <small>Foto dimulai otomatis saat waktu habis</small>
          </div>

          <div className="panel-block">
            <p className="panel-label" style={{ color: labelColor }}>PESERTA · {peers.length}/{room.room?.capacity ?? '—'}</p>
            <ul className="roster">
              {peers.map((peer) => (
                <li key={peer.id}>
                  <span className="roster-dot" style={{ background: peer.role === 'host' ? t.accent : t.line }} />
                  <span className="roster-name">
                    {peer.name}
                    {peer.id === selfId && ' (kamu)'}
                    {peer.role === 'host' && ' · host'}
                    {peer.muted && ' · muted'}
                  </span>
                  {isHost && peer.id !== selfId && (
                    <button className="roster-kick" onClick={() => room.kick(peer.id)} title="Keluarkan peserta">keluarkan</button>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {room.shares.length > 0 && (
            <div className="panel-block">
              <p className="panel-label" style={{ color: labelColor }}>HASIL DIBAGIKAN</p>
              <div className="share-strip">
                {room.shares.slice(0, 3).map((share) => (
                  <a key={share.at} href={share.image} download={`photovirtu-${share.name}.png`}>
                    <img src={share.image} alt={`Hasil dari ${share.name}`} />
                    <span>{share.name}</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          {isHost ? (
            <button className="primary-button full-button" style={{ background: t.accent, color: onAccent, boxShadow: `5px 5px 0 ${t.line}` }} onClick={onStartSession}>
              Mulai foto sekarang
            </button>
          ) : (
            <p className="waiting-guest">Host bisa mulai lebih awal, atau tunggu timer habis.</p>
          )}
          <button className="retake-button" style={{ borderColor: t.line, color: t.ink }} onClick={toggleMute}>
            {muted ? 'Nyalakan mic' : 'Matikan mic'}
          </button>
        </aside>
      </div>
    </main>
  )
}
