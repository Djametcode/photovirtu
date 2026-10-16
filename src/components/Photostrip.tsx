// The printed photostrip: two side-by-side 4-frame strips per template.
// Frame geometry is shared (see art.css); the template only contributes hue
// (inline) plus its own texture class, so all 24 templates stay consistent.
import type { CSSProperties } from 'react'
import { COMIC_BEATS } from '../templates'
import type { PhotoTemplate } from '../templates'

type Props = {
  template: PhotoTemplate
  photos?: string[]
  compact?: boolean
}

export function Photostrip({ template, photos = [], compact = false }: Props) {
  const footer = template.frame === 'web-rush' ? 'MISSION 04 · 2026' : 'PHOTOVIRTU · 2026'
  const glyph = template.frame === 'web-rush' ? '✺' : template.frame === 'disco-fever' ? '✦' : '✹'
  // Compact strips are thumbnails of a template the user is reading beside
  // them; the artwork's 3-6px labels are decoration, so keep them out of the
  // accessibility tree instead of announcing illegible micro-text.
  const decorative = compact && photos.length === 0
  const style = {
    background: template.canvas,
    color: template.ink,
    '--pv-accent': template.accent,
  } as CSSProperties

  return (
    <div
      className={`photostrip frame-${template.frame} ${compact ? 'compact' : ''}`}
      style={style}
      aria-hidden={decorative || undefined}
    >
      {[0, 1].map((copy) => (
        <div className="strip" key={copy}>
          <div className="strip-title">
            <strong>{template.mark}</strong>
            <span>{glyph}</span>
          </div>
          {Array.from({ length: 4 }).map((_, index) => (
            <div className="photo-slot" key={index}>
              {photos[index]
                ? <img src={photos[index]} alt={`Pose ${index + 1}`} />
                : <div className="slot-placeholder"><span>POSE</span><b>0{index + 1}</b></div>}
              {template.frame === 'web-rush' && <span className="comic-beat">{COMIC_BEATS[index]}</span>}
              <em>{template.mark}</em>
            </div>
          ))}
          <div className="strip-footer">{footer}</div>
        </div>
      ))}
    </div>
  )
}
