# photovirtu

Virtual photobooth: pilih template photostrip, buat room, undang teman lewat
kode, ambil 4 pose, dapat 2 photostrip siap print.

## Arsitektur

```
photovirtu/
├── src/                     # React + TypeScript client (Vite)
│   ├── App.tsx              # Screen router + session state
│   ├── templates.ts         # 22 template (strip look + capture theme)
│   ├── components/          # Lobby, SlotCheckout, AdminDashboard, RoomScreen, ...
│   └── lib/
│       ├── roomClient.ts    # Typed WebSocket client
│       ├── slotApi.ts       # Order/payment/admin REST client
│       └── useRoom.ts       # WebRTC mesh + room presence
└── server/                  # Realtime room + payment server (Node + Express 5 + ws)
    ├── src/
    │   ├── index.js         # Boot: HTTP + WebSocket upgrade
    │   ├── app.js           # Express wiring, helmet/CORS, static dist
    │   ├── config.js        # Every env read in one place
    │   ├── db.js            # node:sqlite handle, schema, transactions
    │   ├── protocol.js      # Message handlers, signalling relay, slot gate
    │   ├── rooms.js         # Room registry (hash-keyed)
    │   ├── security.js      # Code generation, hashing, rate limiters, CORS
    │   ├── store/           # settings.js (price + QRIS), orders.js (slot orders)
    │   └── routes/          # public.js, admin.js, respond.js
    └── test/                # e2e + group + security + payments + browser suites
```

HTTP/API memakai **Express 5** dan `helmet`; signalling realtime tetap memakai
`ws` pada Node HTTP server yang sama. Media (video) **peer-to-peer via WebRTC**:
server hanya merelay SDP/ICE, tidak pernah menyimpan atau meneruskan frame video.

## Menjalankan

```bash
# 1. Room server
cd server && npm install && npm start        # :8787

# 2. Client (dev)
npm install && npm run dev                   # :5173

# 3. Client (produksi, untuk uji)
npm run build && npm run preview             # :4173
```

Dev server di `:5173` sudah masuk allowlist origin default. Untuk port lain,
set `ALLOWED_ORIGINS` di server:

```bash
ALLOWED_ORIGINS="http://127.0.0.1:4173,http://localhost:4173" npm start
```

Client memakai origin yang sama dengan halaman (server Node juga menyajikan
`dist/`). Kalau API dipisah ke host lain, set env Vite:

```bash
VITE_API_BASE=https://api.example.com \
VITE_ROOM_SERVER=wss://api.example.com/ws \
npm run build
```

## Slot berbayar: satu slot, satu bilik

Host membayar **satu slot** untuk membuka **satu room**; tamu yang punya kode
undangan **tidak** membayar apa pun. Alurnya:

```
Setup → Checkout (QRIS + nominal) → unggah bukti transfer → admin verifikasi
      → slot aktif → room realtime dibuat → tamu gabung pakai kode
```

```bash
cd server
REQUIRE_SLOT_PAYMENT=1 \
SLOT_PRICE=25000 \
ADMIN_PASSWORD="buat-password-panjang-dan-unik" \
SLOT_DB_PATH=./data/photovirtu.sqlite \
ALLOWED_ORIGINS="https://domain-kamu.com" \
NODE_ENV=production \
npm start
```

Setelan yang bisa kamu ubah tanpa deploy ada di dashboard admin
(`https://domain-kamu.com/admin`): **gambar QRIS merchant**, nominal per slot,
nama merchant, dan keterangan untuk pembeli. Terakhir kali diunggah menang atas
nilai default dari environment.

Endpoint pembayaran:

- `GET /api/config` — flag `payment.required`, nominal, dan apakah QRIS sudah diunggah.
- `GET /api/qris` — gambar QRIS merchant (publik, `no-store`).
- `POST /api/orders` — buat order slot; balas `{ order, token }`. Token ini kredensial pembayar.
- `GET /api/orders/:id` — status order; wajib header `x-order-token`.
- `POST /api/orders/:id/proof` — unggah bukti transfer (data URL, maks 1.2 MB); wajib `x-order-token`.
- `POST /api/admin/login` — menukar password dengan cookie sesi `HttpOnly` (8 jam, path `/api/admin`).
- `GET /api/admin/orders?status=QUEUE` — antrean verifikasi + ringkasan (termasuk pendapatan).
- `GET /api/admin/orders/:id/proof` — pratinjau bukti transfer.
- `POST /api/admin/orders/:id/review` — body `{"decision":"APPROVED"|"REJECTED","note":"..."}`.
- `PUT|DELETE /api/admin/settings/qris` — unggah/hapus gambar QRIS merchant.
- `PUT /api/admin/settings` — nominal, merchant, keterangan.
- `POST /api/admin/logout` — mengakhiri sesi admin.

Dashboard admin tersedia di `/admin` (redirect otomatis dari `/#admin`). Password
hanya hidup di server sebagai `ADMIN_PASSWORD`; browser cuma menerima cookie
`HttpOnly`, `SameSite=Strict` untuk path `/api/admin`.

Siklus hidup order: `PENDING_PAYMENT → PENDING_REVIEW → APPROVED → ACTIVATED`,
dengan `REJECTED`/`EXPIRED`/`CANCELLED` sebagai jalan keluar. Aturannya:

- Approval **wajib** punya bukti transfer; tanpa itu server menjawab `PROOF_REQUIRED`.
- Harga di-*snapshot* ke order saat dibuat, jadi mengubah nominal tidak mengubah order lama.
- Slot bersifat **sekali pakai**: pesan WebSocket `create` membawa `slotToken`, dan
  token itu berubah `ACTIVATED` dalam transaksi yang sama saat room dibuat. Satu
  token tidak bisa membuka room kedua (`SLOT_NOT_APPROVED`).
- Kapasitas room dikunci ke kapasitas yang dibayar (2–4 peserta).
- Room yang tidak dibayar tidak ada sama sekali saat `REQUIRE_SLOT_PAYMENT=1`.
- Order kedaluwarsa setelah `ORDER_TTL_MS` (default 7 hari) dan tidak bisa lagi dikirim bukti.

Set `REQUIRE_SLOT_PAYMENT=0` kalau mau hosting gratis lagi: lobby kembali memakai
tombol "Buat room" tanpa checkout, dan `create` tidak menuntut token.

> SQLite dipakai untuk satu instance. Untuk multi-instance, pindahkan order/kuota
> ke managed PostgreSQL dan state realtime/rate-limit ke Redis.

### Ganti QRIS lewat dashboard

1. Login di `/admin` dengan `ADMIN_PASSWORD`.
2. Panel "QRIS & nominal": unggah PNG/JPG/WebP (maks 500 KB) dan isi nominal.
3. Checkout memakai gambar itu langsung (`GET /api/qris`), tanpa CDN pihak ketiga —
   CSP hanya mengizinkan gambar dari origin sendiri.

## Model keamanan

Akses room dikunci oleh kode undangan. Keputusan desainnya:

| Aspek | Implementasi |
|---|---|
| Kode undangan | 8 karakter dari alfabet 32 simbol tanpa look-alike (no I/L/O/U). Keyspace 32^8 ≈ 1.1e12 |
| Penyimpanan kode | Server **tidak pernah** menyimpan plaintext. Hanya SHA-256 digest sebagai key room |
| Distribusi kode | Dikirim sekali ke host saat `create`, tidak pernah masuk roster/broadcast |
| Hak host | Token kapabilitas terpisah (32 byte acak). Membagikan kode room tidak membagikan hak admin |
| Pemeriksaan kode | Constant-time compare; kegagalan selalu `ROOM_NOT_FOUND` tanpa membocorkan info |
| Normalisasi | Case/format-insensitive (`virtu-8` = `VIRTU8`) supaya UX enak tanpa mengurangi entropi |
| Rate limit | Token bucket per IP: join 6/menit, pesan 30 burst, share 2/20s. Membuat brute-force online tidak praktis |
| Origin | Handshake WebSocket ditolak kalau `Origin` tidak ada di allowlist |
| Kapasitas | Maks 8 peer/room, maks 5000 room, socket per IP dibatasi |
| Signalling | Relay hanya ke peer yang benar-benar ada di room yang sama |
| Payload | Frame dibatasi 2 MB; SDP 20 KB; share image wajib `data:image/*` maks 1.5 MB |
| Nama tampilan | Control char dibuang, dipangkas 24 karakter |
| Pembersihan | Heartbeat memutus socket mati; room idle kedaluwarsa; host keluar menutup room |
| Media | P2P; server tidak punya akses ke video |

Roster publik sengaja hanya berisi `id`, `name`, `role`, `muted`, `joinedAt` —
tidak ada data sensitif yang bisa dipanen.

### Yang belum ada (batas jujur)

- **Tanpa autentikasi**: siapa pun yang tahu kode bisa masuk. Itu memang model
  "share link" ala photobooth. Kalau butuh room privat, tambahkan login.
- **Tanpa TURN**: STUN publik dipakai. Di belakang NAT simetris ketat, sebagian
  pasangan gagal connect; itu butuh server TURN (kredensial sendiri).
- **State in-memory**: restart server menghapus semua room. Untuk produksi
  multi-instance, pindahkan registry ke Redis dengan pub/sub.
- **Tanpa enkripsi E2E tambahan**: WebRTC sudah DTLS-SRTP, tapi bukan
  end-to-end dari sisi aplikasi.

## Testing

```bash
cd server
npm test                      # e2e + group + security + payments (protocol, no browser)
node test/browser.mjs         # dua browser asli, verifikasi WebRTC P2P
```

`browser.mjs` butuh Chrome terpasang dan server berjalan. Suite ini menggerakkan
UI hasil build di dua konteks browser terpisah, lalu memastikan video peer
sampai (track live dengan frame).

**Penting:** jalankan server dengan kuota longgar sebelum menjalankan semua
suite berurutan. `security.js` sengaja membanjiri limiter join, dan limiter itu
per-IP — jadi suite berikutnya di IP yang sama akan ikut ter-throttle dan
gagal dengan pesan `RATE_LIMITED`, bukan karena ada bug.

```bash
# Server untuk sesi testing
ALLOWED_ORIGINS="http://127.0.0.1:4173,http://localhost:4173" \
JOIN_CAPACITY=500 MSG_CAPACITY=2000 npm start
```

Kalau `browser.mjs` timeout menunggu `.room-page`, hampir selalu itu penyebabnya:
cek `curl http://127.0.0.1:8787/health` dan pastikan origin client ada di
`ALLOWED_ORIGINS`.

Cakupan:
- `e2e.js` — create/join, relay signal, kick, share, teardown, batas privilege.
- `group.js` — sesi bareng: start host-only, deadline identik, fan-out frame,
  penolakan frame cacat, `session:complete`, sesi ulang.
- `security.js` — brute-force 200k kode, origin palsu, rate limit, sanitasi,
  batas ukuran, isolasi relay.
- `payments.js` — order slot, unggah bukti, verifikasi admin, harga terkunci,
  QRIS, expiry, dan aturan satu slot satu room.
- `browser.mjs` — alur UI nyata + negosiasi WebRTC + penolakan kode salah.
- `group-browser.mjs` — **bukti foto bareng**: dua peserta di dua konteks
  browser, sesi tersinkron otomatis, lalu memastikan tiap strip berisi
  `4 pose x 2 orang = 8 gambar` dan kedua klien menyusun strip yang sama.

## Alur aplikasi

```
Home → Setup (template + kapasitas) → Checkout slot (kalau berbayar) → Room
     → Capture bareng (4 pose tersinkron) → Hasil (1 strip grup)
```

### Foto bareng (shared session)

Ini inti produknya: peserta **tidak** memotret sendiri-sendiri. Host menekan
"Mulai sesi bareng", dan seluruh room memotret di instan yang sama.

1. Host mengirim `session:start` berisi `poses`, `intervalMs`, `startAt`, dan
   `serverNow`.
2. Server hanya mengizinkan host memulai; peserta lain menerima sinyal yang sama
   persis (sessionId, deadline identik).
3. Klien menghitung `lead = startAt - serverNow` lalu memetakannya ke jam lokal.
   Ini membuang selisih jam antar perangkat tanpa perlu mengukur RTT.
4. Setiap klien membidik pose ke-`n` pada `startAt + n * intervalMs`, jadi
   shutter-nya serempak.
5. Setelah punya semua frame, klien mengirim `session:frames`. Server
   mem-broadcast ke semua peserta dan menandai siapa saja yang sudah kirim.
6. Begitu jumlah pengirim == jumlah peserta, server mengirim
   `session:complete`.
7. Tiap klien menyusun strip yang **identik**: setiap baris pose berisi frame
   dari semua peserta, bersebelahan.

Kalau satu peserta tidak mengirim, sesi tidak pernah `complete` — itu disengaja,
karena strip grup tanpa satu orang pun akan menyesatkan.

Ketua room memilih template di Setup; pilihannya ikut ke seluruh room lewat
`room:update` sehingga semua peserta melihat tema yang sama.
