// Connection screens: create a room, or join one with an invite code.
import { useState } from 'react'
import type { PhotoTemplate } from '../templates'
import { Icon } from './Icon'
import { Photostrip } from './Photostrip'

type Props = {
  template: PhotoTemplate
  busy: boolean
  error: string | null
  paymentRequired: boolean
  price: string | null
  onBack: () => void
  onCreate: (name: string, templateId: string, roomSize: number) => void
  onJoin: (code: string, name: string) => void
  onRequestSlot: (name: string) => void
}

const roomSizes = [2, 3, 4]

export function Lobby({ template, busy, error, paymentRequired, price, onBack, onCreate, onJoin, onRequestSlot }: Props) {
  const [mode, setMode] = useState<'host' | 'guest'>('host')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [roomSize, setRoomSize] = useState(4)

  const cleanName = name.trim().slice(0, 24)
  const cleanCode = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  const canHost = cleanName.length >= 2 && !busy
  const canJoin = cleanName.length >= 2 && cleanCode.length === 8 && !busy

  return (
    <main className="lobby-page">
      <header className="page-header">
        <button onClick={onBack}>← Kembali</button>
        <span>SESI BERSAMA</span>
        <i />
      </header>

      <div className="lobby-layout">
        <section className="lobby-card">
          <div className="lobby-tabs" aria-label="Pilihan akses room">
            <button type="button" aria-pressed={mode === 'host'} className={mode === 'host' ? 'is-active' : ''} onClick={() => setMode('host')}>Buat room</button>
            <button type="button" aria-pressed={mode === 'guest'} className={mode === 'guest' ? 'is-active' : ''} onClick={() => setMode('guest')}>Gabung</button>
          </div>

          <label htmlFor="lobby-name">Nama kamu</label>
          <input
            id="lobby-name"
            value={name}
            maxLength={24}
            placeholder="Contoh: Nadia"
            autoComplete="name"
            autoCapitalize="words"
            enterKeyHint="next"
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
          />

          {mode === 'host' ? (
            paymentRequired ? (
              <>
                {/* Hosting is the paid action: one slot buys one room. */}
                <div className="lobby-gate">
                  <p>SLOT BERBAYAR</p>
                  <span>
                    Membuat bilik butuh satu slot lunas{price ? ` (${price})` : ''}. Bayar lewat QRIS, unggah buktinya,
                    lalu bilik aktif begitu admin memverifikasi.
                  </span>
                </div>
                <button className="primary-button full-button" disabled={cleanName.length < 2} onClick={() => onRequestSlot(cleanName)}>
                  Pesan slot{price ? ` · ${price}` : ''} <Icon name="arrow" size={17} />
                </button>
                <p className="lobby-hint">Temanmu tidak perlu bayar — cukup bagikan kode undangan dari bilikmu.</p>
              </>
            ) : (
              <>
                <label>Kapasitas room</label>
                <div className="size-options compact">
                  {roomSizes.map((size) => (
                    <button key={size} type="button" aria-pressed={size === roomSize} className={size === roomSize ? 'is-selected' : ''} onClick={() => setRoomSize(size)}>
                      {size}<small> org</small>
                    </button>
                  ))}
                </div>
                <p className="lobby-hint">Template <strong>{template.name}</strong> dipakai untuk seluruh room.</p>
                <button className="primary-button full-button" disabled={!canHost} onClick={() => onCreate(cleanName, template.id, roomSize)}>
                  {busy ? 'Menyiapkan…' : 'Buat room & undang teman'}
                </button>
              </>
            )
          ) : (
            <>
              <label htmlFor="lobby-code">Kode undangan</label>
              <input
                id="lobby-code"
                value={cleanCode}
                maxLength={8}
                placeholder="8 karakter"
                className="mono-input"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="characters"
                enterKeyHint="go"
                spellCheck={false}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
              <p className="lobby-hint">
                {paymentRequired
                  ? 'Minta host membagikan kode 8 karakter. Gabung gratis, tanpa akun.'
                  : 'Minta host membagikan kode 8 karakter dari roomnya.'}
              </p>
              <button className="primary-button full-button" disabled={!canJoin} onClick={() => onJoin(cleanCode, cleanName)}>
                {busy ? 'Menghubungkan…' : 'Masuk ke room'}
              </button>
            </>
          )}

          {error && <p className="lobby-error" role="alert">{error}</p>}
        </section>

        <aside className="lobby-preview">
          <p>PRATINJAU TEMPLATE</p>
          <div className="summary-preview" style={{ background: template.canvas }}>
            <Photostrip template={template} compact />
          </div>
          <dl>
            <div><dt>Template</dt><dd>{template.name}</dd></div>
            <div><dt>Foto</dt><dd>4 pose berurutan</dd></div>
            <div><dt>Video</dt><dd>Peer-to-peer</dd></div>
            {paymentRequired && <div><dt>Biaya bilik</dt><dd>{price ?? '—'} / slot</dd></div>}
          </dl>
        </aside>
      </div>
    </main>
  )
}
