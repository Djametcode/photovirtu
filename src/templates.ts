// Photostrip templates: each defines both the printed strip look (canvas/ink/
// accent/frame) and the capture-screen theme so a pick carries end to end.
export type TemplateId =
  | 'web-rush' | 'cyber-arcade' | 'cosmic-club' | 'cherry-racing'
  | 'pixel-pop' | 'neon-tokyo' | 'glitch-aesthetic' | 'y2k-chrome'
  | 'disco-fever' | 'flower-power' | 'tropical-pop' | 'bubblegum' | 'black-film'
  | 'scrapbook-club' | 'future-medieval' | 'neon-noir' | 'denim-cloud' | 'citrus-studio' | 'punk-zine'
  | 'film-grain' | 'sage-botanical' | 'vinyl-express'

export type CaptureTheme = {
  bg: string
  panel: string
  line: string
  accent: string
  ink: string
  onAccent: string
}

export type PhotoTemplate = {
  id: TemplateId
  name: string
  description: string
  mark: string
  canvas: string
  ink: string
  accent: string
  frame: string
  theme: CaptureTheme
}

export const templates: PhotoTemplate[] = [
  { id: 'web-rush', name: 'Web Rush', description: 'Comic red-blue dengan garis jaring orisinal dan energi kota malam.', mark: 'WEB RUSH', canvas: '#e51e36', ink: '#ffffff', accent: '#1665d8', frame: 'web-rush', theme: { bg: '#1c0609', panel: '#2b0b11', line: '#1665d8', accent: '#e51e36', ink: '#ffffff', onAccent: '#ffffff' } },
  { id: 'cyber-arcade', name: 'Cyber Arcade', description: 'Neon arcade dengan grid laser dan score-card energy.', mark: 'INSERT COIN', canvas: '#100c2d', ink: '#8fffff', accent: '#ff4fd8', frame: 'cyber-arcade', theme: { bg: '#08061b', panel: '#150f38', line: '#8fffff', accent: '#ff4fd8', ink: '#8fffff', onAccent: '#100c2d' } },
  { id: 'cosmic-club', name: 'Cosmic Club', description: 'Aurora galaksi dengan stempel orbit dan chrome detail.', mark: 'MOON MODE', canvas: '#21105b', ink: '#f4efff', accent: '#70f1dd', frame: 'cosmic-club', theme: { bg: '#150a3d', panel: '#241155', line: '#70f1dd', accent: '#b665ff', ink: '#f4efff', onAccent: '#21105b' } },
  { id: 'cherry-racing', name: 'Cherry Racing', description: 'Motorsport pop dengan checkerboard dan aksen cherry red.', mark: 'FAST FRIENDS', canvas: '#f13d4e', ink: '#fffaf0', accent: '#161827', frame: 'cherry-racing', theme: { bg: '#1a1c2a', panel: '#242636', line: '#f13d4e', accent: '#f13d4e', ink: '#fffaf0', onAccent: '#fffaf0' } },
  { id: 'pixel-pop', name: 'Pixel Pop', description: 'Retro 8-bit arcade—blocky borders, glitch scanlines, dan high-score energy.', mark: 'PLAYER 1', canvas: '#1a1c2a', ink: '#64ffda', accent: '#ff71ce', frame: 'pixel-pop', theme: { bg: '#0b0d18', panel: '#1a1c2a', line: '#64ffda', accent: '#ff71ce', ink: '#64ffda', onAccent: '#0e1020' } },
  { id: 'neon-tokyo', name: 'Neon Tokyo', description: 'Cyberpunk shibuya—holographic foil, neon pink strip, dan kanji-inspired border.', mark: 'TOKYO DRIFT', canvas: '#0d0a1a', ink: '#f0e6ff', accent: '#ff2d95', frame: 'neon-tokyo', theme: { bg: '#08060f', panel: '#16102a', line: '#ff2d95', accent: '#ff2d95', ink: '#f0e6ff', onAccent: '#0d0a1a' } },
  { id: 'glitch-aesthetic', name: 'Glitch Aesthetic', description: 'RGB split, noise grain, dan digital corruption untuk vibe experimental.', mark: 'CORRUPTED', canvas: '#0f0f0f', ink: '#00ff88', accent: '#ff0044', frame: 'glitch-aesthetic', theme: { bg: '#050505', panel: '#131313', line: '#00ff88', accent: '#ff0044', ink: '#00ff88', onAccent: '#ffffff' } },
  { id: 'y2k-chrome', name: 'Y2K Chrome', description: 'Chrome, bintang, dan warna candy ala era 2000-an.', mark: 'CYBER CUTIE', canvas: '#c9b7ff', ink: '#261447', accent: '#ff62b3', frame: 'y2k-chrome', theme: { bg: '#b9a6f5', panel: '#d9ccff', line: '#ff62b3', accent: '#ff62b3', ink: '#261447', onAccent: '#261447' } },
  { id: 'disco-fever', name: 'Disco Fever', description: 'Bola disko, kilau emas, dan mood dance floor.', mark: 'STAY GROOVY', canvas: '#6d2bbd', ink: '#fff4b2', accent: '#ffb703', frame: 'disco-fever', theme: { bg: '#351066', panel: '#4d1a8f', line: '#ffb703', accent: '#ffb703', ink: '#fff4b2', onAccent: '#2c0e5c' } },
  { id: 'flower-power', name: 'Flower Power', description: 'Bunga retro penuh warna untuk foto yang playful.', mark: 'LOVE BLOOMS', canvas: '#f85a91', ink: '#fffdf6', accent: '#f7d34a', frame: 'flower-power', theme: { bg: '#c9366c', panel: '#f85a91', line: '#f7d34a', accent: '#f7d34a', ink: '#fffdf6', onAccent: '#9d1c51' } },
  { id: 'tropical-pop', name: 'Tropical Pop', description: 'Warna pulau cerah, citrus, dan summer vibes.', mark: 'SUNNY CLUB', canvas: '#ff7c43', ink: '#12395b', accent: '#0ac8c9', frame: 'tropical-pop', theme: { bg: '#d95722', panel: '#ff7c43', line: '#0ac8c9', accent: '#0ac8c9', ink: '#12395b', onAccent: '#12395b' } },
  { id: 'bubblegum', name: 'Bubblegum', description: 'Pastel pink dengan hearts dan stiker gaya diary.', mark: 'SWEET SNAP', canvas: '#ffb6d9', ink: '#7d1755', accent: '#a94eff', frame: 'bubblegum', theme: { bg: '#ff8fc4', panel: '#ffc9e3', line: '#a94eff', accent: '#a94eff', ink: '#7d1755', onAccent: '#ffffff' } },
  { id: 'black-film', name: 'Black Film', description: 'Editorial film strip minimal, dua salinan siap dibagi.', mark: 'PHOTOVIRTU', canvas: '#111115', ink: '#fffaf5', accent: '#ff8a4c', frame: 'black-film', theme: { bg: '#0a0a0c', panel: '#16161a', line: '#ff8a4c', accent: '#ff8a4c', ink: '#fffaf5', onAccent: '#111115' } },
  { id: 'scrapbook-club', name: 'Scrapbook Club', description: 'Kolase memo, tape warna, dan stiker catatan untuk momen yang terasa personal.', mark: 'KEEP THIS', canvas: '#f4dfb9', ink: '#25324a', accent: '#ef5a75', frame: 'scrapbook-club', theme: { bg: '#e8cfa4', panel: '#fff5df', line: '#25324a', accent: '#ef5a75', ink: '#25324a', onAccent: '#fffaf0' } },
  { id: 'future-medieval', name: 'Future Medieval', description: 'Bingkai gothic futuristik dengan gold foil, orbit, dan drama kerajaan digital.', mark: 'ROYAL SIGNAL', canvas: '#201541', ink: '#fff4d1', accent: '#d8ad49', frame: 'future-medieval', theme: { bg: '#110b27', panel: '#24174a', line: '#d8ad49', accent: '#d8ad49', ink: '#fff4d1', onAccent: '#21113f' } },
  { id: 'neon-noir', name: 'Neon Noir', description: 'Malam basah, lampu magenta, dan kilau cyan untuk mood cinematic setelah gelap.', mark: 'AFTER HOURS', canvas: '#101227', ink: '#dffcff', accent: '#ff3b9a', frame: 'neon-noir', theme: { bg: '#070817', panel: '#12152d', line: '#46e6ff', accent: '#ff3b9a', ink: '#dffcff', onAccent: '#17071a' } },
  { id: 'denim-cloud', name: 'Denim Cloud', description: 'Sky blue, jahitan denim, dan awan puffy yang soft tapi tetap playful.', mark: 'BLUE HOUR', canvas: '#75b9e6', ink: '#13365d', accent: '#fff7e6', frame: 'denim-cloud', theme: { bg: '#367bab', panel: '#88c8ee', line: '#fff7e6', accent: '#fff7e6', ink: '#13365d', onAccent: '#214e78' } },
  { id: 'citrus-studio', name: 'Citrus Studio', description: 'Poster buah yang juicy: orange, lime, dan tipografi studio penuh tenaga.', mark: 'FRESH TAKE', canvas: '#ff8e27', ink: '#173b34', accent: '#d9f23e', frame: 'citrus-studio', theme: { bg: '#d95b1c', panel: '#ffa039', line: '#173b34', accent: '#d9f23e', ink: '#173b34', onAccent: '#173b34' } },
  { id: 'punk-zine', name: 'Punk Zine', description: 'Kertas fotokopi, type besar, dan sobekan neon untuk energi DIY yang berani.', mark: 'MAKE NOISE', canvas: '#e5e0d4', ink: '#121212', accent: '#ec1d65', frame: 'punk-zine', theme: { bg: '#161616', panel: '#eeeee7', line: '#121212', accent: '#ec1d65', ink: '#121212', onAccent: '#fff' } },
  { id: 'film-grain', name: 'Film Grain', description: 'High-contrast hitam-putih dengan grain halus seperti cetakan film klasik.', mark: 'MONOCHROME', canvas: '#121212', ink: '#f0f0f0', accent: '#888888', frame: 'film-grain', theme: { bg: '#080808', panel: '#1a1a1a', line: '#555555', accent: '#888888', ink: '#f0f0f0', onAccent: '#121212' } },
  { id: 'sage-botanical', name: 'Sage Botanical', description: 'Hijau sage earthy dengan sentuhan floral, daun pers, dan aksen dusty rose.', mark: 'NATURE CLUB', canvas: '#cfe1d0', ink: '#2b4a3e', accent: '#d4838f', frame: 'sage-botanical', theme: { bg: '#aec7b3', panel: '#d6e5d6', line: '#2b4a3e', accent: '#d4838f', ink: '#2b4a3e', onAccent: '#faf9f2' } },
  { id: 'vinyl-express', name: 'Vinyl Express', description: 'Nuansa retro 70-an dengan hangatnya warna krem, dusty brown, dan sentuhan emas.', mark: 'GROOVE MODE', canvas: '#f2e8d5', ink: '#4a3525', accent: '#c8923e', frame: 'vinyl-express', theme: { bg: '#d6c8b0', panel: '#f5edd8', line: '#4a3525', accent: '#c8923e', ink: '#4a3525', onAccent: '#faf6ed' } },
]

export function findTemplate(id: string | null | undefined): PhotoTemplate {
  return templates.find((item) => item.id === id) ?? templates[0]
}

export const COMIC_BEATS = ['READY!', 'BOOST!', 'FLASH!', 'WIN!']
