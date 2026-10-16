import { useEffect, useState } from 'react'
import { Icon } from './components/Icon'
import { Photostrip } from './components/Photostrip'
import { Lobby } from './components/Lobby'
import { RoomScreen } from './components/RoomScreen'
import { GroupStrip, SharedCaptureScreen } from './components/GroupSession'
import type { ParticipantFrames } from './components/GroupSession'
import { SlotCheckout } from './components/SlotCheckout'
import { AdminDashboard } from './components/AdminDashboard'
import { useRoom } from './lib/useRoom'
import { readableOn } from './lib/contrast'
import { fetchConfig, formatMoney } from './lib/slotApi'
import type { AppConfig } from './lib/slotApi'
import { findTemplate, templates } from './templates'

// 'shared' is the only capture route: the room's session is authoritative and
// every participant shoots the same poses at the same instants, then each
// client composes the identical group strip.
type View = 'home' | 'setup' | 'lobby' | 'checkout' | 'room' | 'shared'

// WebRTC mesh on mobile is intentionally capped at four participants.
const roomSizes = [2, 3, 4]
const POSES = 4
const LEAD_MS = 4000
const INTERVAL_MS = 2600

// The home page tells one short story in four frames.
const STEPS = [
  { n: '01', title: 'Buat bilik', body: 'Pilih frame dan kapasitas, lalu bagikan kode 8 karakter ke temanmu.' },
  { n: '02', title: 'Panggil teman', body: 'Mereka gabung lewat browser — tanpa install, tanpa akun.' },
  { n: '03', title: 'Jepret 4 pose', body: 'Shutter tersinkron: semua peserta memotret di detik yang sama.' },
  { n: '04', title: 'Strip-nya jadi', body: 'Semua foto digabung jadi satu strip grup, siap diunduh atau dicetak.' },
]

function App() {
  const [view, setView] = useState<View>('home')
  const [templateId, setTemplateId] = useState('web-rush')
  const [roomSize, setRoomSize] = useState(4)
  const [ownName, setOwnName] = useState('Kamu')
  const [checkoutName, setCheckoutName] = useState('')
  const [checkoutBack, setCheckoutBack] = useState<View>('setup')
  const [config, setConfig] = useState<AppConfig | null>(null)
  const selectedTemplate = findTemplate(templateId)
  const room = useRoom()

  // The operator decides whether hosting costs a slot; the public config is the
  // single source of truth so the copy matches what the server will enforce.
  useEffect(() => {
    let cancelled = false
    void fetchConfig()
      .then((next) => { if (!cancelled) setConfig(next) })
      .catch(() => { /* the server error path is authoritative when config fails */ })
    return () => { cancelled = true }
  }, [])

  const paymentRequired = Boolean(config?.payment.required)
  const price = config?.payment.required && config.payment.amount > 0
    ? formatMoney(config.payment.amount, config.payment.currency)
    : null
  const paidLabel = price ? `Pesan slot · ${price}` : 'Pesan slot'

  // The host picks the template for the whole room; follow it once it arrives.
  useEffect(() => {
    if (room.room?.templateId && room.room.templateId !== templateId) setTemplateId(room.room.templateId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.room?.templateId])

  const exitRoom = () => { room.leave(); setView('home') }
  const leaveLobby = () => { room.leave(); room.clearKicked(); setView('home') }

  const startSharedSession = () => room.startSession(POSES, LEAD_MS, INTERVAL_MS)

  // Socket confirmed membership: an approved slot enters the same live room
  // route as a normal invite-code join.
  useEffect(() => {
    if ((view === 'lobby' || view === 'checkout') && room.status === 'connected' && room.room) setView('room')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.status, room.room, view])

  // A started session pulls every participant into the group capture screen,
  // wherever they happened to be in the flow.
  useEffect(() => {
    if (!room.session) return
    setView('shared')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.session?.sessionId])

  // Losing the room (kick, host left) must never strand the user on a live screen.
  useEffect(() => {
    if (!room.kicked) return
    setView('lobby')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.kicked])

  // Admin is a regular path so it works with bookmarks, reverse proxies and
  // browser history. Keep the old hash URL as a one-time compatibility redirect.
  if (window.location.hash === '#admin') {
    window.history.replaceState(null, '', '/admin')
  }
  if (window.location.pathname.replace(/\/+$/, '') === '/admin') return <AdminDashboard />

  if (view === 'checkout') {
    return <SlotCheckout
      template={selectedTemplate}
      capacity={roomSize}
      initialName={checkoutName}
      payment={config?.payment ?? null}
      maxProofBytes={config?.order.maxProofBytes ?? 1_200_000}
      onBack={() => { room.leave(); setView(checkoutBack) }}
      onApproved={(name, slotToken, id, size) => {
        setOwnName(name); setTemplateId(id); setRoomSize(size)
        room.create(name, id, size, slotToken)
      }}
    />
  }

  if (view === 'setup') {
    return (
      <Setup
        template={selectedTemplate}
        templateId={templateId}
        setTemplateId={setTemplateId}
        roomSize={roomSize}
        setRoomSize={setRoomSize}
        price={price}
        onBack={() => setView('home')}
        onNext={() => { if (paymentRequired) { setCheckoutName(''); setCheckoutBack('setup'); setView('checkout') } else setView('lobby') }}
      />
    )
  }

  if (view === 'lobby') {
    return (
      <Lobby
        template={selectedTemplate}
        busy={room.status === 'connecting'}
        error={room.error ?? room.kicked}
        paymentRequired={paymentRequired}
        price={price}
        onBack={leaveLobby}
        onCreate={(name, id, size) => { setOwnName(name); setTemplateId(id); setRoomSize(size); room.create(name, id, size) }}
        onJoin={(code, name) => { setOwnName(name); room.join(code, name) }}
        onRequestSlot={(name) => { setCheckoutName(name); setCheckoutBack('lobby'); setView('checkout') }}
      />
    )
  }

  if (view === 'room') {
    return <RoomScreen template={selectedTemplate} room={room} onStartSession={startSharedSession} onExit={exitRoom} />
  }

  if (view === 'shared') {
    // All frames in: compose the group strip. Own frames are merged in locally
    // because the server echoes ours back too; dedupe by peer id.
    if (room.sessionComplete) {
      const byId = new Map<string, ParticipantFrames>()
      if (room.selfId) byId.set(room.selfId, { peerId: room.selfId, name: `${ownName} (kamu)`, frames: room.ownFrames })
      for (const p of room.sessionFrames) byId.set(p.peerId, p)
      const participants = [...byId.values()].filter((p) => p.frames.length > 0)
      return (
        <GroupResult
          template={selectedTemplate}
          participants={participants}
          poses={room.session?.poses ?? POSES}
          onRetake={() => { room.setOwnFrames([]); startSharedSession() }}
          onHome={exitRoom}
        />
      )
    }

    // A session ended without us capturing (e.g. we joined mid-round): show a
    // safe waiting screen rather than an empty strip.
    return (
      <SharedCaptureScreen
        template={selectedTemplate}
        session={room.session}
        participants={room.sessionFrames}
        ownFrames={room.ownFrames}
        ownName={ownName}
        roomCount={room.room?.peers.length ?? 1}
        countdown={room.countdown}
        isHost={room.isHost}
        onStart={startSharedSession}
        onFrames={(frames) => {
          room.setOwnFrames(frames)
          const poses = room.session?.poses ?? POSES
          if (frames.length === poses && room.session) room.submitFrames(room.session.sessionId, frames)
        }}
      />
    )
  }

  // Home
  return (
    <main className="site-shell pv-aurora">
      <header className="nav pv-glass">
        <div className="nav-inner shell">
          <button className="brand" onClick={() => setView('home')}>
            <span className="brand-mark"><Icon name="camera" size={19} /></span>photovirtu
          </button>
          <button className="nav-action" onClick={() => setView('setup')}>{paymentRequired ? 'Pesan slot' : 'Request room'}</button>
        </div>
      </header>

      <section className="hero shell">
        <p className="eyebrow"><Icon name="sparkles" size={15} /> VIRTUAL PHOTOBOOTH</p>
        <h1>Empat pose, satu strip, <em>bareng-bareng</em>.</h1>
        <p className="hero-description">
          Buat bilik foto online, undang teman lewat kode 8 karakter, lalu jepret empat pose di detik yang sama.
          Hasilnya satu photostrip grup.
        </p>
        <div className="hero-buttons">
          <button className="primary-button" onClick={() => setView('setup')}>
            {paymentRequired ? paidLabel : 'Request room gratis'} <Icon name="arrow" size={17} />
          </button>
          <button className="secondary-button" onClick={() => setView('lobby')}>Gabung pakai kode</button>
        </div>
        <ul className="hero-meta">
          <li>{templates.length} template</li>
          <li>{POSES} pose per sesi</li>
          <li>maks. {roomSize} orang</li>
          <li>{paymentRequired ? `${price ?? 'Slot berbayar'} per bilik` : 'gratis, tanpa install'}</li>
        </ul>

        <div className="booth">
          <div className="booth-glow" aria-hidden="true" />
          <div className="booth-slot" aria-hidden="true" />
          <div className="booth-strip"><Photostrip template={findTemplate('y2k-chrome')} compact /></div>
        </div>
        <p className="booth-caption">Dua salinan dicetak — satu untukmu, satu untuk temanmu.</p>
      </section>

      <section className="story shell">
        <div className="story-head">
          <p className="eyebrow"><Icon name="sparkles" size={15} /> CERITANYA SINGKAT</p>
          <h2>Dari bilik kosong sampai strip jadi.</h2>
          <p>Empat langkah, sekitar satu menit. Semua terjadi di browser.</p>
        </div>
        <div className="film">
          {STEPS.map((step) => (
            <article className="film-frame" key={step.n}>
              <span className="step-num">{step.n}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="final-cta shell">
        <h2>Biliknya siap dipakai.</h2>
        <p>
          {paymentRequired
            ? `Satu slot berbayar untuk bilik maks. ${roomSize} orang, temanmu gabung gratis pakai kode. Video berjalan peer-to-peer, jadi fotonya tidak disimpan di server.`
            : `Gratis untuk ${roomSize} orang per bilik. Video berjalan peer-to-peer, jadi fotonya tidak disimpan di server.`}
        </p>
        <div className="cta-row">
          <button className="primary-button" onClick={() => setView('setup')}>
            {paymentRequired ? paidLabel : 'Request room gratis'} <Icon name="arrow" size={17} />
          </button>
          <button className="secondary-button" onClick={() => setView('lobby')}>Gabung pakai kode</button>
        </div>
      </section>

      <footer className="site-footer shell">
        <span><b>photovirtu</b> · photobooth online untuk foto bareng dari tempat berbeda</span>
        <span>Video peer-to-peer · photostrip dibuat di perangkatmu</span>
      </footer>
    </main>
  )
}

function Setup({ template, templateId, setTemplateId, roomSize, setRoomSize, price, onBack, onNext }: { template: ReturnType<typeof findTemplate>; templateId: string; setTemplateId: (id: string) => void; roomSize: number; setRoomSize: (size: number) => void; price: string | null; onBack: () => void; onNext: () => void }) {
  // Paying adds a third step after the template and the capacity.
  const totalSteps = price ? 3 : 2
  return (
    <main className="setup-page pv-aurora">
      <header className="page-header"><button onClick={onBack}>← Kembali</button><span>SETUP PHOTOBOX</span><i /></header>
      <div className="setup-layout">
        <section>
          <p className="step-label">LANGKAH 1 / {totalSteps}</p>
          <h1>Pilih frame hasil kalian.</h1>
          <p className="page-intro">Template ini dipakai untuk strip grup setelah sesi selesai — semua peserta muncul berdampingan di setiap pose.</p>
          <div className="template-grid">
            {templates.map((item) => (
              <button aria-pressed={item.id === templateId} key={item.id} className={`template-option ${item.id === templateId ? 'is-selected' : ''}`} onClick={() => setTemplateId(item.id)}>
                <div className="template-visual" style={{ background: item.canvas }}><Photostrip template={item} compact /></div>
                <strong>{item.name}</strong>
                <span>{item.description}</span>
                {item.id === templateId && <b><Icon name="check" size={14} /></b>}
              </button>
            ))}
          </div>
          <p className="template-scroll-hint"><Icon name="arrow" size={14} /> Geser untuk lihat semua {templates.length} template</p>
          <div className="room-picker">
            <p className="step-label">LANGKAH 2 / {totalSteps}</p>
            <h2>Berapa orang dalam room?</h2>
            <p>Atur kapasitas peserta yang bisa kamu undang.</p>
            <div className="size-options">
              {roomSizes.map((size) => (
                <button key={size} aria-pressed={size === roomSize} className={size === roomSize ? 'is-selected' : ''} onClick={() => setRoomSize(size)}>
                  {size}<small> org</small>
                </button>
              ))}
            </div>
          </div>
        </section>
        <aside className="setup-summary">
          <p>RINGKASAN SESI</p>
          <div className="summary-preview" style={{ background: template.canvas }}><Photostrip template={template} compact /></div>
          <dl>
            <div><dt>Template</dt><dd>{template.name}</dd></div>
            <div><dt>Peserta</dt><dd>Maks. {roomSize} orang</dd></div>
            <div><dt>Output</dt><dd>Strip grup · {POSES} pose</dd></div>
            {price && <div><dt>Biaya slot</dt><dd>{price}</dd></div>}
          </dl>
          <button className="primary-button full-button" onClick={onNext}>
            {price ? 'Lanjut bayar QRIS' : 'Lanjut ke room'} <Icon name="arrow" size={17} />
          </button>
        </aside>
      </div>
    </main>
  )
}

function GroupResult({ template, participants, poses, onRetake, onHome }: { template: ReturnType<typeof findTemplate>; participants: ParticipantFrames[]; poses: number; onRetake: () => void; onHome: () => void }) {
  const t = template.theme
  const names = participants.map((p) => p.name).join(', ')
  // The result page is painted with theme colours, so panel text and the CTA
  // get theme-aware contrast instead of a raw ink/accent pairing.
  const labelColor = readableOn(t.accent, t.panel)
  const onAccent = readableOn(t.onAccent, t.accent)
  const bodyInk = readableOn(t.ink, t.panel)
  return (
    <main className="result-page result-themed" style={{ background: `linear-gradient(150deg, ${t.bg}, ${t.panel})`, color: bodyInk }}>
      <header className="page-header">
        <button onClick={onHome}>← Selesai</button>
        <span className="label-chip">HASIL BARENG · {participants.length} ORANG</span>
        <i />
      </header>
      <div className="result-layout">
        <section className="print-desk" style={{ background: t.panel, borderColor: t.line }}>
          <div id="print-sheet"><GroupStrip template={template} participants={participants} poses={poses} /></div>
        </section>
        <aside className="result-actions" style={{ background: t.panel, color: bodyInk }}>
          <span className="success-mark" style={{ background: t.accent, color: onAccent }}><Icon name="check" size={22} /></span>
          <p className="step-label" style={{ color: labelColor }}>SESI BARENG SELESAI</p>
          <h1 style={{ color: bodyInk }}>Foto kalian sudah jadi.</h1>
          <p style={{ color: bodyInk }}>
            {poses} pose dari {participants.length} orang sudah digabung dalam satu strip. Setiap pose menampilkan kalian berdampingan.
          </p>
          <p className="group-names" style={{ color: bodyInk }}>{names}</p>
          <button className="primary-button full-button" style={{ background: t.accent, color: onAccent }} onClick={() => window.print()}>
            <Icon name="download" size={17} /> Download / print
          </button>
          <button className="retake-button" style={{ borderColor: t.line, color: bodyInk }} onClick={onRetake}>
            <Icon name="rotate" size={17} /> Ulangi sesi bareng
          </button>
          <small style={{ color: bodyInk }}>Pilih “Save as PDF” di dialog print untuk menyimpan.</small>
        </aside>
      </div>
    </main>
  )
}

export default App
