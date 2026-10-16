// Composes a shared group photostrip: every pose row shows ALL participants
// side by side, so the strip is genuinely a group photo, not a solo collage.
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { cameraErrorMessage, cameraSupported } from '../lib/camera'
import { readableOn } from '../lib/contrast'
import type { PhotoTemplate } from '../templates'

export type SharedSession = {
  sessionId: string
  poses: number
  intervalMs: number
  startAt: number
  endAt: number
}

export type ParticipantFrames = {
  peerId: string
  name: string
  frames: string[]
}

type Template = PhotoTemplate

const POSE_LABEL = ['READY!', 'BOOST!', 'FLASH!', 'WIN!', 'EXTRA!', 'BONUS!']

// One pose row: the same-index frame from every participant, in a stable order
// so the group layout matches across all clients.
export function GroupPoseRow({ frames }: { frames: string[] }) {
  const count = Math.max(frames.length, 1)
  return (
    <div className={`group-row group-cols-${Math.min(count, 4)}`}>
      {frames.map((src, index) => (
        <div className="group-cell" key={index}>
          {src ? <img src={src} alt={`Peserta ${index + 1}`} /> : <div className="group-cell-empty" />}
        </div>
      ))}
    </div>
  )
}

export function GroupStrip({ template, participants, poses }: { template: Template; participants: ParticipantFrames[]; poses: number }) {
  const style = {
    background: template.canvas,
    color: template.ink,
    '--pv-accent': template.accent,
  } as CSSProperties
  return (
    <div className={`photostrip frame-${template.frame} group-strip`} style={style}>
      <div className="strip">
        <div className="strip-title">
          <strong>{template.mark}</strong>
          <span>GROUP · {participants.length} ORG</span>
        </div>
        {Array.from({ length: poses }).map((_, poseIndex) => (
          <div className="group-pose" key={poseIndex}>
            <span className="group-pose-label">{POSE_LABEL[poseIndex] ?? `POSE ${poseIndex + 1}`}</span>
            <GroupPoseRow
              frames={participants.map((p) => p.frames[poseIndex]).filter(Boolean) as string[]}
            />
          </div>
        ))}
        <div className="strip-footer">PHOTOVIRTU · GROUP SESSION</div>
      </div>
    </div>
  )
}

type CaptureProps = {
  template: Template
  session: SharedSession | null
  participants: ParticipantFrames[]
  ownFrames: string[]
  ownName: string
  // Total people in the room (including self), not just those who submitted.
  roomCount: number
  countdown: number | null
  onStart: () => void
  onFrames: (frames: string[]) => void
  isHost: boolean
}

export function SharedCaptureScreen({ template, session, participants, ownFrames, ownName, roomCount, countdown, onStart, onFrames, isHost }: CaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [flash, setFlash] = useState(false)
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
  const [camError, setCamError] = useState<string | null>(null)
  const [camRetry, setCamRetry] = useState(0)

  useEffect(() => {
    let stream: MediaStream | null = null
    let cancelled = false
    if (!cameraSupported()) {
      setCamError(cameraErrorMessage(null))
      return
    }
    setCamError(null)
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'user' }, audio: false })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        stream = s
        setCamError(null)
        if (videoRef.current) videoRef.current.srcObject = s
      })
      .catch((err) => {
        if (!cancelled) setCamError(cameraErrorMessage(err))
      })
    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
    }
    // Re-run when the user retries after granting permission.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camRetry])

  // Drive the visible hard-stop timer independently from the pose countdown.
  useEffect(() => {
    if (!session) return
    const update = () => setSecondsLeft(Math.max(0, Math.ceil((session.endAt - Date.now()) / 1000)))
    const timer = window.setInterval(update, 250)
    return () => window.clearInterval(timer)
  }, [session])

  // Fire the shutter at the shared interval. The deadline comes from the server
  // clock (converted by useRoom), so every client shoots at the same instant.
  useEffect(() => {
    if (!session) return
    if (ownFrames.length >= session.poses || Date.now() >= session.endAt) return
    const targetAt = session.startAt + ownFrames.length * session.intervalMs
    const wait = Math.max(0, targetAt - Date.now())
    const timer = window.setTimeout(() => {
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas || !video.videoWidth) return
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.translate(canvas.width, 0)
      ctx.scale(-1, 1)
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      // Visual shutter feedback is intentionally brief and translucent; the
      // live camera remains visible so people can keep their pose.
      setFlash(true)
      window.setTimeout(() => setFlash(false), 220)
      const next = [...ownFrames, canvas.toDataURL('image/jpeg', 0.78)]
      onFrames(next)
    }, wait)
    return () => window.clearTimeout(timer)
  }, [session, ownFrames, onFrames])

  const formatRemaining = (seconds: number | null) => {
    if (seconds === null) return '02:00'
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  }

  const total = Math.max(roomCount, participants.length + 1)
  const done = ownFrames.length
  // The capture page paints the strip colour full-bleed, so every label needs a
  // surface it can actually be read on: a dark chip over the canvas, the theme
  // panel for the side column, and a solid pill for the over-video countdown.
  const t = template.theme
  const countdownBg = '#120c22'
  const labelColor = readableOn(t.accent, t.panel)
  const onAccent = readableOn(t.onAccent, t.accent)
  const markInk = readableOn(t.ink, t.accent)
  const countdownInk = readableOn(t.accent, countdownBg)

  return (
    <main className="capture-page shared-capture" style={{ background: template.canvas, color: template.ink }}>
      <header className="capture-header">
        <span className="shared-badge">FOTO BARENG · {total} ORANG</span>
        <div className="capture-timers">
          <b>{done}/{session?.poses ?? 4} POSE</b>
          <span className={secondsLeft !== null && secondsLeft <= 20 ? 'is-urgent' : ''}>SESI {formatRemaining(secondsLeft)}</span>
        </div>
      </header>

      <div className="shared-layout">
        <section className="shared-stage">
          <video ref={videoRef} autoPlay muted playsInline className="mirror" />
          {camError && (
            <div className="cam-block" role="alert">
              <p className="cam-block-msg">{camError}</p>
              <button className="cam-block-retry" onClick={() => setCamRetry((n) => n + 1)}>
                Coba lagi
              </button>
            </div>
          )}
          <div className="camera-frame-overlay" style={{ borderColor: template.accent }}>
            <span className="overlay-mark" style={{ background: template.accent, color: markInk }}>{template.mark}</span>
            <span className="overlay-count">
              {countdown !== null && countdown > 0 ? countdown : `POSE ${Math.min(done + 1, session?.poses ?? 4)}`}
            </span>
          </div>
          {countdown !== null && countdown > 0 && (
            <div className="countdown shared-countdown" aria-live="polite">
              <strong style={{ color: countdownInk }}>{countdown}</strong>
              <span>SIAP POSE</span>
            </div>
          )}
          {flash && <div className="flash-overlay" aria-hidden="true" />}
        </section>

        <aside className="shared-side" style={{ background: t.panel, color: t.ink, borderColor: t.line }}>
          <p className="panel-label" style={{ color: labelColor }}>POSE BERSAMA</p>
          <p className="shared-hint">
            {session
              ? `Semua peserta memotret di detik yang sama, lalu hasilnya digabung dalam satu strip.`
              : isHost
                ? 'Tekan mulai, semua peserta otomatis ikut hitung mundur.'
                : 'Menunggu host memulai sesi…'}
          </p>

          <div className="shared-progress">
            {Array.from({ length: session?.poses ?? 4 }).map((_, index) => (
              <div key={index} className={`shared-thumb ${ownFrames[index] ? 'filled' : ''}`} style={{ borderColor: template.accent }}>
                {ownFrames[index] ? <img src={ownFrames[index]} alt={`Pose ${index + 1}`} /> : <span>{index + 1}</span>}
              </div>
            ))}
          </div>

          <p className="shared-status">Kamu · {ownName}</p>
          {participants.length > 0 && (
            <p className="shared-status">Sudah terkirim: {participants.map((p) => p.name).join(', ')}</p>
          )}

          {!session && isHost && (
            <button className="primary-button full-button" style={{ background: template.accent, color: onAccent }} onClick={onStart}>
              Mulai sesi bareng
            </button>
          )}
          {session && done < session.poses && <p className="shared-wait" role="status">Tahan pose sampai semua frame selesai.</p>}
          {session && done >= session.poses && <p className="shared-wait" role="status">Terkirim. Menunggu peserta lain…</p>}
        </aside>
      </div>

      <canvas ref={canvasRef} hidden />
    </main>
  )
}
