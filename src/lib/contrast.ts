// Contrast math for theme-driven surfaces.
//
// Every template ships a decorative `accent` plus an `ink`/`onAccent` pair.
// Those colours are chosen for the *strip artwork*, not for text, so painting
// them as small UI labels can drop below WCAG AA. The helpers below keep the
// palette's identity while nudging a colour just far enough to stay legible.
// Pure functions, safe to call during render.

type Rgb = [number, number, number]

function parseHex(hex: string): Rgb {
  const value = hex.trim().replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) || 0) as Rgb
}

function toHex(rgb: Rgb) {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`
}

export function luminance(hex: string) {
  const [r, g, b] = parseHex(hex).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string) {
  const l1 = luminance(a)
  const l2 = luminance(b)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

/**
 * Return `color` when it already clears `min` against `bg`, otherwise walk it
 * toward white (on dark backgrounds) or black (on light ones) until it does.
 * The hue is preserved, so the result still reads as the theme's accent.
 */
export function readableOn(color: string, bg: string, min = 4.5) {
  if (!color || !bg) return color
  if (contrastRatio(color, bg) >= min) return color

  const from = parseHex(color)
  const to: Rgb = luminance(bg) < 0.5 ? [255, 255, 255] : [0, 0, 0]
  let candidate = color
  for (let step = 1; step <= 24; step += 1) {
    const t = step / 24
    candidate = toHex([0, 1, 2].map((i) => from[i] + (to[i] - from[i]) * t) as Rgb)
    if (contrastRatio(candidate, bg) >= min) return candidate
  }
  return toHex(to)
}

/** Text colour that stays legible on an accent-filled surface (badges, chips). */
export function readableInk(color: string, accent: string) {
  return readableOn(color, accent)
}
