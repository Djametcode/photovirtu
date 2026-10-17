import { useEffect, useRef, useState } from 'react'
import {
  createSlotOrder,
  fetchSlotOrder,
  formatMoney,
  qrisSrc,
  readImageAsDataUrl,
  slotErrorMessage,
  uploadPaymentProof,
} from '../lib/slotApi'
import type { PaymentConfig, SlotOrder } from '../lib/slotApi'
import type { PhotoTemplate } from '../templates'

type StoredOrder = { id: string; token: string; name: string; templateId: string; capacity: number }
type Props = {
  template: PhotoTemplate
  capacity: number
  initialName?: string
  payment: PaymentConfig | null
  maxProofBytes: number
  onBack: () => void
  onApproved: (name: string, token: string, templateId: string, capacity: number) => void
}

const ROOM_SIZES = [2, 3, 4]
const POLL_MS = 5_000
const STORAGE_KEY = 'photovirtu:slot-order'
const OPEN_STATUSES = ['PENDING_PAYMENT', 'PENDING_REVIEW', 'APPROVED']

function readStoredOrder(): StoredOrder | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null')
    if (!value?.id || !value?.token || !value?.name || !value?.templateId) return null
    return value as StoredOrder
  } catch {
    return null
  }
}

export function SlotCheckout({ template, capacity, initialName = '', payment, maxProofBytes, onBack, onApproved }: Props) {
  const [name, setName] = useState(initialName.slice(0, 80))
  const [eventName, setEventName] = useState('')
  const [size, setSize] = useState(capacity)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [order, setOrder] = useState<SlotOrder | null>(null)
  const [proofPreview, setProofPreview] = useState<string | null>(null)
  const activating = useRef(false)
  const cleanName = name.trim().slice(0, 80)
  const cleanEvent = eventName.trim().slice(0, 100)

  const price = payment ? formatMoney(payment.amount, payment.currency) : '—'
  const qrisReady = Boolean(payment?.hasQris)

  // Resume an order the payer already started in this tab: reloading the page
  // must never lose a payment that is already waiting for review.
  useEffect(() => {
    const saved = readStoredOrder()
    if (!saved) return
    let cancelled = false
    void (async () => {
      try {
        const result = await fetchSlotOrder(saved.id, saved.token)
        if (!cancelled) setOrder(result.order)
      } catch {
        sessionStorage.removeItem(STORAGE_KEY)
      }
    })()
    return () => { cancelled = true }
  }, [])

  async function refresh(showHint = false) {
    const saved = readStoredOrder()
    if (!saved || activating.current) return
    try {
      const result = await fetchSlotOrder(saved.id, saved.token)
      setOrder(result.order)
      if (OPEN_STATUSES.includes(result.order.status)) setError(null)
      else if (showHint) setError(null)
    } catch (reason) {
      // Keep polling on transient failures; never drop the payer's token.
      if (showHint) setError(slotErrorMessage(reason))
    }
  }

  // The queue is asynchronous: poll only while a decision is still pending so
  // an admin approval moves the payer into the room without a refresh.
  useEffect(() => {
    if (!order || !OPEN_STATUSES.includes(order.status)) return
    const timer = window.setInterval(() => { void refresh() }, POLL_MS)
    return () => window.clearInterval(timer)
    // refresh reads the current session token on each tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id, order?.status])

  // A slot is one-use: hand it to the room exactly once.
  useEffect(() => {
    if (order?.status !== 'APPROVED' || activating.current) return
    const saved = readStoredOrder()
    if (!saved) return
    activating.current = true
    onApproved(saved.name, saved.token, saved.templateId, saved.capacity)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.status])

  async function startOrder() {
    if (cleanName.length < 2 || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await createSlotOrder({
        requesterName: cleanName,
        eventName: cleanEvent || 'Photovirtu room',
        capacity: size,
        templateId: template.id,
      })
      const saved: StoredOrder = {
        id: result.order.id,
        token: String(result.token),
        name: cleanName,
        templateId: template.id,
        capacity: result.order.capacity,
      }
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
      setOrder(result.order)
    } catch (reason) {
      setError(slotErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  async function sendProof(file: File | undefined) {
    const saved = readStoredOrder()
    if (!file || !saved || busy) return
    setBusy(true)
    setError(null)
    try {
      const image = await readImageAsDataUrl(file, maxProofBytes)
      setProofPreview(image)
      const result = await uploadPaymentProof(saved.id, saved.token, image)
      setOrder(result.order)
    } catch (reason) {
      setError(slotErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  function restart() {
    sessionStorage.removeItem(STORAGE_KEY)
    activating.current = false
    setOrder(null)
    setProofPreview(null)
    setError(null)
  }

  const step: 'form' | 'pay' | 'waiting' | 'closed' = !order
    ? 'form'
    : order.status === 'PENDING_PAYMENT' ? 'pay'
      : order.status === 'APPROVED' ? 'waiting'
        : order.status === 'PENDING_REVIEW' ? 'waiting'
          : 'closed'

  const statusLabel = order?.status === 'APPROVED' ? 'LUNAS · MENYIAPKAN ROOM'
    : order?.status === 'PENDING_REVIEW' ? 'MENUNGGU VERIFIKASI ADMIN'
      : order?.status === 'REJECTED' ? 'PEMBAYARAN DITOLAK'
        : order?.status === 'EXPIRED' ? 'ORDER KEDALUWARSA'
          : order?.status === 'CANCELLED' ? 'ORDER DIBATALKAN'
            : 'MENUNGGU PEMBAYARAN'

  return (
    <main className="checkout-page pv-aurora">
      <header className="page-header">
        <button onClick={onBack}>← Kembali</button>
        <span>BAYAR SLOT</span>
        <i />
      </header>

      <section className="checkout-card">
        <ol className="checkout-steps" aria-label="Langkah pembayaran">
          <li className={step === 'form' ? 'is-active' : 'is-done'}><b>1</b> Detail</li>
          <li className={step === 'pay' ? 'is-active' : step === 'form' ? '' : 'is-done'}><b>2</b> Bayar QRIS</li>
          <li className={step === 'waiting' || step === 'closed' ? 'is-active' : ''}><b>3</b> Verifikasi</li>
        </ol>

        {step === 'form' && <>
          <p className="checkout-kicker">SATU SLOT · SATU BILIK</p>
          <h1>Bayar dulu,<br />biliknya langsung jadi.</h1>
          <p>Satu pembayaran membuka satu bilik. Teman-temanmu gabung gratis pakai kode undangan.</p>
          <label htmlFor="slot-name">Nama kamu</label>
          <input id="slot-name" value={name} maxLength={80} placeholder="Contoh: Nadia" autoComplete="name" onChange={(event) => setName(event.target.value)} />
          <label htmlFor="slot-event">Nama acara (opsional)</label>
          <input id="slot-event" value={eventName} maxLength={100} placeholder="Contoh: Bukber divisi desain" onChange={(event) => setEventName(event.target.value)} />
          <label>Kapasitas bilik</label>
          <div className="size-options compact">
            {ROOM_SIZES.map((option) => (
              <button key={option} type="button" aria-pressed={option === size} className={option === size ? 'is-selected' : ''} onClick={() => setSize(option)}>
                {option}<small> org</small>
              </button>
            ))}
          </div>
          <div className="checkout-summary">
            <span>Template</span><b>{template.name}</b>
            <span>Kapasitas</span><b>Maks. {size} orang</b>
            <span>Total bayar</span><b className="checkout-price">{price}</b>
          </div>
          <button className="primary-button full-button" disabled={cleanName.length < 2 || busy} onClick={() => void startOrder()}>
            {busy ? 'Menyiapkan order…' : `Lanjut bayar ${price}`}
          </button>
          <p className="checkout-hint">Sudah punya kode undangan? Gabung saja — teman tidak perlu bayar.</p>
        </>}

        {step === 'pay' && order && <>
          <p className="checkout-kicker">BAYAR QRIS</p>
          <h1>Scan, bayar,<br />unggah buktinya.</h1>
          <p>{payment?.instructions ?? 'Scan QRIS di bawah, bayar sesuai nominal, lalu unggah bukti transfernya.'}</p>
          {qrisReady ? (
            <figure className="checkout-qris">
              <img src={qrisSrc(payment?.qrisUpdatedAt)} alt={`QRIS ${payment?.merchant ?? 'merchant'}`} />
              <figcaption>{payment?.merchant}</figcaption>
            </figure>
          ) : (
            <p className="lobby-error" role="alert">Admin belum mengunggah QRIS. Hubungi admin sebelum transfer ya.</p>
          )}
          <div className="checkout-amount">
            <span>Nominal</span>
            <b>{formatMoney(order.amount, order.currency)}</b>
          </div>
          <div className="checkout-summary">
            <span>Order ID</span><b className="mono-value">{order.reference}</b>
            <span>Atas nama</span><b>{order.requesterName}</b>
            <span>Berlaku sampai</span><b>{new Date(order.expiresAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}</b>
          </div>
          <label className="checkout-upload" htmlFor="slot-proof">
            <b>{proofPreview ? 'Ganti bukti transfer' : 'Unggah bukti transfer'}</b>
            <span>Screenshot atau foto m-banking. Foto besar otomatis dikompres.</span>
          </label>
          <input id="slot-proof" className="checkout-file" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={busy} onChange={(event) => void sendProof(event.target.files?.[0])} />
          {proofPreview && <img className="checkout-proof-preview" src={proofPreview} alt="Pratinjau bukti transfer" />}
          {busy && <p className="checkout-hint">Mengunggah bukti…</p>}
        </>}

        {step === 'waiting' && order && <>
          <p className="checkout-kicker">VERIFIKASI</p>
          <h1>{order.status === 'APPROVED' ? 'Pembayaran lunas.' : 'Bukti terkirim.'}</h1>
          <p>
            {order.status === 'APPROVED'
              ? 'Slot aktif — bilikmu sedang disiapkan.'
              : 'Admin mengecek bukti transfermu sebentar lagi. Halaman ini memperbarui status otomatis, jangan tutup tab ini.'}
          </p>
          <div className="checkout-status"><b>{statusLabel}</b><span>Order {order.reference}</span></div>
          <div className="checkout-summary">
            <span>Dibayar</span><b>{formatMoney(order.amount, order.currency)}</b>
            <span>Bilik untuk</span><b>Maks. {order.capacity} orang</b>
          </div>
          <button className="primary-button full-button" disabled={busy || order.status === 'APPROVED'} onClick={async () => { setBusy(true); await refresh(true); setBusy(false) }}>
            {order.status === 'APPROVED' ? 'Menyiapkan bilik…' : busy ? 'Memeriksa…' : 'Cek status sekarang'}
          </button>
          <p className="checkout-hint">Belum transfer? <button type="button" className="link-button" onClick={restart}>Buat order baru</button></p>
        </>}

        {step === 'closed' && order && <>
          <p className="checkout-kicker">ORDER BELUM AKTIF</p>
          <h1>Slot ini belum<br />bisa dipakai.</h1>
          <p>{order.reviewNote || 'Admin menandai pembayaran ini belum masuk. Kamu bisa membuat order baru dan mengunggah bukti yang benar.'}</p>
          <div className="checkout-status"><b>{statusLabel}</b><span>Order {order.reference}</span></div>
          <button className="primary-button full-button" onClick={restart}>Buat order baru</button>
        </>}

        {error && <p className="lobby-error" role="alert">{error}</p>}
      </section>
    </main>
  )
}
