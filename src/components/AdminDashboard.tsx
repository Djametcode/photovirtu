import { useEffect, useState, type FormEvent } from 'react'
import {
  deleteQris,
  fetchAdminSettings,
  formatMoney,
  listOrders,
  loginAdmin,
  logoutAdmin,
  proofSrc,
  qrisSrc,
  readImageAsDataUrl,
  reviewOrder,
  saveAdminSettings,
  slotErrorMessage,
  uploadQris,
} from '../lib/slotApi'
import type { OrdersSummary, PaymentConfig, SlotOrder, SlotStatus } from '../lib/slotApi'

const TABS: Array<{ id: string; label: string }> = [
  { id: 'QUEUE', label: 'Perlu tindakan' },
  { id: 'ALL', label: 'Semua' },
  { id: 'PENDING_PAYMENT', label: 'Belum bayar' },
  { id: 'APPROVED', label: 'Disetujui' },
  { id: 'ACTIVATED', label: 'Terpakai' },
  { id: 'REJECTED', label: 'Ditolak' },
  { id: 'EXPIRED', label: 'Kedaluwarsa' },
]

const STATUS_LABEL: Record<SlotStatus, string> = {
  PENDING_PAYMENT: 'BELUM BAYAR',
  PENDING_REVIEW: 'BUTUH VERIFIKASI',
  APPROVED: 'SIAP DIPAKAI',
  ACTIVATED: 'SUDAH DIPAKAI',
  REJECTED: 'DITOLAK',
  EXPIRED: 'KEDALUWARSA',
  CANCELLED: 'DIBATALKAN',
}

const MAX_QRIS_BYTES = 512_000

export function AdminDashboard() {
  const [password, setPassword] = useState('')
  const [orders, setOrders] = useState<SlotOrder[]>([])
  const [summary, setSummary] = useState<OrdersSummary | null>(null)
  const [settings, setSettings] = useState<PaymentConfig | null>(null)
  const [requirePayment, setRequirePayment] = useState(true)
  const [tab, setTab] = useState('QUEUE')
  const [draft, setDraft] = useState({ amount: '', merchant: '', instructions: '' })
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)

  async function loadOrders(status = tab) {
    const result = await listOrders(status)
    setOrders(result.orders)
    setSummary(result.summary)
    setLastUpdated(Date.now())
  }

  async function loadSettings() {
    const result = await fetchAdminSettings()
    setSettings(result.settings)
    setRequirePayment(result.requirePayment)
    setDraft({
      amount: String(result.settings.amount),
      merchant: result.settings.merchant,
      instructions: result.settings.instructions,
    })
  }

  async function load(silent = false, status = tab) {
    setLoading(true)
    if (!silent) setError(null)
    try {
      await loadOrders(status)
      await loadSettings()
    } catch (reason) {
      setSummary(null)
      // On the initial unauthenticated probe there is no session yet, so a 401
      // is expected: show the login form, not a scary "session expired" error.
      if (!silent) setError(slotErrorMessage(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(true) }, 0)
    return () => window.clearTimeout(timer)
    // load is intentionally initial-session scoped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!summary) return
    const timer = window.setInterval(() => { void load(true).catch(() => {}) }, 15_000)
    return () => window.clearInterval(timer)
    // Polling is active only while an authenticated dashboard is visible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(summary)])

  async function login(event?: FormEvent) {
    event?.preventDefault()
    if (!password || loading) return
    setLoading(true)
    setError(null)
    try {
      await loginAdmin(password)
      setPassword('')
      await loadOrders()
      await loadSettings()
      setLastUpdated(Date.now())
    } catch (reason) {
      setError(slotErrorMessage(reason))
    } finally {
      setLoading(false)
    }
  }

  async function review(id: string, decision: 'APPROVED' | 'REJECTED', requesterName: string) {
    if (decision === 'REJECTED' && !window.confirm(`Tolak pembayaran ${requesterName}?`)) return
    setLoading(true)
    setError(null)
    try {
      const result = await reviewOrder(id, decision)
      await loadOrders()
      setNotice(`${requesterName}: ${STATUS_LABEL[result.order.status].toLowerCase()}`)
    } catch (reason) {
      setError(slotErrorMessage(reason))
    } finally {
      setLoading(false)
    }
  }

  async function switchTab(next: string) {
    setTab(next)
    setLoading(true)
    setError(null)
    try {
      await loadOrders(next)
    } catch (reason) {
      setError(slotErrorMessage(reason))
    } finally {
      setLoading(false)
    }
  }

  async function saveSettings(event?: FormEvent) {
    event?.preventDefault()
    setLoading(true)
    setError(null)
    setNotice(null)
    try {
      const result = await saveAdminSettings({
        amount: Number.parseInt(draft.amount, 10) || 0,
        merchant: draft.merchant,
        instructions: draft.instructions,
        currency: settings?.currency ?? 'IDR',
      })
      setSettings(result.settings)
      setNotice('Nominal dan keterangan pembayaran tersimpan.')
      await loadOrders()
    } catch (reason) {
      setError(slotErrorMessage(reason))
    } finally {
      setLoading(false)
    }
  }

  async function changeQris(file: File | undefined) {
    if (!file) return
    setLoading(true)
    setError(null)
    setNotice(null)
    try {
      const image = await readImageAsDataUrl(file, MAX_QRIS_BYTES)
      const result = await uploadQris(image)
      setSettings(result.settings)
      setNotice('QRIS baru tersimpan.')
    } catch (reason) {
      setError(slotErrorMessage(reason))
    } finally {
      setLoading(false)
    }
  }

  async function removeQris() {
    if (!window.confirm('Hapus gambar QRIS? Checkout akan menampilkan peringatan sampai diunggah lagi.')) return
    setLoading(true)
    try {
      const result = await deleteQris()
      setSettings(result.settings)
      setNotice('QRIS dihapus.')
    } catch (reason) {
      setError(slotErrorMessage(reason))
    } finally {
      setLoading(false)
    }
  }

  async function logout() {
    await logoutAdmin().catch(() => {})
    setSummary(null)
    setOrders([])
    setSettings(null)
    setError(null)
  }

  return <main className="admin-page pv-aurora">
    <header className="page-header"><a href="/">← Ke photovirtu</a><span>ADMIN SLOT</span><i /></header>

    <section className="admin-shell">
      <div className="admin-top">
        <div><p className="checkout-kicker">PEMBAYARAN QRIS</p><h1>Verifikasi slot.</h1></div>
        {summary && <button onClick={() => void logout()}>Keluar</button>}
      </div>

      {!summary && <>
        <form className="admin-login" onSubmit={(event) => void login(event)}>
          <label htmlFor="admin-password">Password admin</label>
          <input id="admin-password" name="password" type="password" autoComplete="current-password" value={password} placeholder="Masukkan password admin" onChange={(event) => setPassword(event.target.value)} />
          <button className="primary-button" type="submit" disabled={!password || loading}>{loading ? 'Memeriksa…' : 'Masuk dashboard'}</button>
        </form>
        {error && <p className="lobby-error" role="alert">{error}</p>}
      </>}

      {summary && <>
        <div className="admin-metrics">
          <div><span>BUTUH VERIFIKASI</span><b>{summary.awaitingReview}</b></div>
          <div><span>BELUM BAYAR</span><b>{summary.awaitingPayment}</b></div>
          <div><span>SLOT TERPAKAI</span><b>{summary.activated}</b></div>
          <div><span>PENDAPATAN</span><b>{formatMoney(summary.revenue, summary.currency)}</b></div>
        </div>

        <div className="admin-tabs" role="tablist" aria-label="Filter order">
          {TABS.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'is-active' : ''} onClick={() => void switchTab(item.id)}>{item.label}</button>
          ))}
        </div>

        <div className="admin-toolbar">
          <span>{lastUpdated ? `Diperbarui ${new Date(lastUpdated).toLocaleTimeString('id-ID')}` : 'Memuat data…'} · {orders.length} order</span>
          <button onClick={() => void load()} disabled={loading}>{loading ? 'Memuat…' : 'Segarkan'}</button>
        </div>

        {notice && <p className="admin-notice" role="status">{notice}</p>}
        {error && <p className="lobby-error" role="alert">{error}</p>}

        <div className="admin-list">
          {orders.length === 0
            ? <p className="admin-empty">Tidak ada order di tab ini.</p>
            : orders.map((order) => (
              <article key={order.id} className={`admin-request status-${order.status}`}>
                <div className="admin-request-main">
                  <b>{order.requesterName} · {formatMoney(order.amount, order.currency)}</b>
                  <span>{order.eventName}</span>
                  <small>{new Date(order.createdAt).toLocaleString('id-ID')} · maks. {order.capacity} orang · order {order.reference}</small>
                  <em className="admin-badge">{STATUS_LABEL[order.status]}</em>
                  {order.reviewNote && <small>Catatan: {order.reviewNote}</small>}
                </div>
                <div className="admin-request-proof">
                  {order.hasProof
                    ? <a href={proofSrc(order.id, order.proofAt)} target="_blank" rel="noreferrer">
                      <img src={proofSrc(order.id, order.proofAt)} alt={`Bukti transfer ${order.requesterName}`} />
                      <span>Buka bukti</span>
                    </a>
                    : <p className="admin-no-proof">Belum ada bukti transfer</p>}
                </div>
                <div className="admin-actions">
                  <button className="approve" onClick={() => void review(order.id, 'APPROVED', order.requesterName)} disabled={loading || !order.hasProof || order.status !== 'PENDING_REVIEW'}>Setujui</button>
                  <button className="reject" onClick={() => void review(order.id, 'REJECTED', order.requesterName)} disabled={loading || order.status !== 'PENDING_REVIEW'}>Tolak</button>
                </div>
              </article>
            ))}
        </div>
      </>}
    </section>

    {summary && <section className="admin-shell">
      <div className="admin-top"><div><p className="checkout-kicker">SETELAN PEMBAYARAN</p><h2>QRIS &amp; nominal</h2></div></div>
      <p className="admin-note">
        Checkout memakai setelan ini. {requirePayment
          ? 'Pembayaran wajib: host harus punya slot lunas sebelum bilik dibuat.'
          : 'Server sedang mode gratis (REQUIRE_SLOT_PAYMENT=0), jadi slot tidak diminta saat membuat bilik.'}
      </p>

      <div className="admin-settings">
        <div className="admin-qris">
          {settings?.hasQris
            ? <>
              <img src={qrisSrc(settings.qrisUpdatedAt)} alt="QRIS merchant yang aktif" />
              <div className="admin-qris-actions">
                <label htmlFor="admin-qris-file">Ganti QRIS</label>
                <button type="button" onClick={() => void removeQris()} disabled={loading}>Hapus</button>
              </div>
            </>
            : <>
              <p className="admin-no-proof">Belum ada QRIS diunggah.</p>
              <label htmlFor="admin-qris-file">Unggah QRIS</label>
            </>}
          <input id="admin-qris-file" className="checkout-file" type="file" accept="image/png,image/jpeg,image/webp" disabled={loading} onChange={(event) => void changeQris(event.target.files?.[0])} />
          <small>PNG/JPG/WebP, maks {Math.round(MAX_QRIS_BYTES / 1024)} KB.</small>
        </div>

        <form className="admin-form" onSubmit={(event) => void saveSettings(event)}>
          <label htmlFor="admin-amount">Nominal per slot ({settings?.currency ?? 'IDR'})</label>
          <input id="admin-amount" inputMode="numeric" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value.replace(/[^0-9]/g, '') })} />
          <label htmlFor="admin-merchant">Nama merchant</label>
          <input id="admin-merchant" value={draft.merchant} maxLength={80} onChange={(event) => setDraft({ ...draft, merchant: event.target.value })} />
          <label htmlFor="admin-instructions">Keterangan untuk pembeli</label>
          <textarea id="admin-instructions" rows={3} maxLength={400} value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} />
          <button className="primary-button" type="submit" disabled={loading}>{loading ? 'Menyimpan…' : 'Simpan setelan'}</button>
        </form>
      </div>
    </section>}
  </main>
}
