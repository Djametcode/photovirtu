// Grid tile that renders a remote peer's live P2P video stream.
import { useEffect, useRef } from 'react'

type Props = {
  stream: MediaStream
  name: string
  accent: string
  muted: boolean
}

export function PeerVideo({ stream, name, accent, muted }: Props) {
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (el.srcObject !== stream) el.srcObject = stream
    // Autoplay can be rejected if the page has no prior interaction; that is a
    // normal browser policy, so we degrade to a paused poster instead of throwing.
    el.play().catch(() => undefined)
  }, [stream])

  return (
    <div className="peer-tile">
      <video ref={ref} autoPlay playsInline muted={muted} />
      <div className="peer-scrim" />
      <span className="peer-name" style={{ borderColor: accent }}>{name}</span>
    </div>
  )
}
