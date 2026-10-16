# Photovirtu — Kebijakan Slot Berbayar (QRIS)

## Aturan yang diputuskan

- **Satu slot berbayar = satu room.** Host membayar sekali; tamu yang punya kode
  undangan bergabung **gratis**.
- **Tidak ada kuota slot gratis.** Tidak ada angka 100, tidak ada jatah pilot:
  room ada kalau pembayarannya sudah diverifikasi.
- Harga ditentukan admin (dashboard `/admin`), bukan hard-code di frontend. Harga
  di-*snapshot* ke order saat order dibuat, jadi mengubah nominal tidak mengubah
  order yang sudah jalan.
- **Pembayaran diverifikasi manual.** Pembayar mengunggah bukti transfer, admin
  menekan Setujui/Tolak. Tidak ada auto-approve.
- Approval **wajib** punya bukti transfer. Tanpa bukti, server menolak dengan
  `PROOF_REQUIRED`.
- Slot bersifat **sekali pakai**: token order berubah `ACTIVATED` dalam transaksi
  yang sama saat room dibuat, sehingga satu pembayaran tidak bisa membuka dua room.
- Room realtime/WebSocket/WebRTC hanya boleh dibuat setelah slot `APPROVED`.
  Order `PENDING_PAYMENT`/`PENDING_REVIEW`/`REJECTED` tidak pernah membuka socket media.
- Kapasitas room dikunci ke kapasitas yang dibayar, maksimal 4 peserta. Room
  banyak peserta bukan mode yang aman untuk WebRTC mesh dan baru bisa dibuka
  setelah ada SFU.

## Alur pembayar (host)

```
Landing
  -> Setup: pilih template + kapasitas (maks 4)
  -> Checkout: lihat nominal, scan QRIS merchant, transfer
  -> Unggah screenshot bukti transfer
  -> Order PENDING_REVIEW; halaman menunggu sambil polling status
  -> Admin menyetujui
  -> Room otomatis dibuat, kode undangan muncul, teman tinggal gabung
```

Kalau tab ditutup, order tetap tersimpan di `sessionStorage` browser yang sama;
membuka halaman checkout lagi akan melanjutkan order yang belum selesai.

## Alur admin

```
Dashboard /admin
  -> Login (ADMIN_PASSWORD -> cookie HttpOnly 8 jam)
  -> Lihat antrean: butuh verifikasi / belum bayar / terpakai
  -> Buka bukti transfer, cocokkan nominal
  -> Setujui -> slot aktif dan host bisa membuat room
  -> Tolak (dengan alasan) bila transfer tidak masuk / nominal salah
  -> Panel "QRIS & nominal": unggah gambar QRIS merchant + atur harga
```

## Model status

| Status | Makna | Bisa membuka room? | Dihitung pendapatan? |
|---|---|---:|---:|
| `PENDING_PAYMENT` | Order dibuat, belum ada bukti | Tidak | Tidak |
| `PENDING_REVIEW` | Bukti sudah diunggah, menunggu admin | Tidak | Tidak |
| `APPROVED` | Pembayaran lolos verifikasi | Ya, sekali | Ya |
| `ACTIVATED` | Slot sudah dipakai untuk satu room | Tidak (habis) | Ya |
| `REJECTED` | Ditolak admin (transfer tidak ditemukan) | Tidak | Tidak |
| `EXPIRED` | Lewat `ORDER_TTL_MS` (default 7 hari) | Tidak | Tidak |
| `CANCELLED` | Dibatalkan pembayar/admin | Tidak | Tidak |

## Aturan kapasitas dan abuse

- Order creation dibatasi per IP (`ORDER_CREATE_CAPACITY`, default 5/jam) supaya
  antrean review tidak bisa dibanjiri bot.
- Unggah bukti dibatasi terpisah (`PROOF_CAPACITY`, default 8 per 10 menit).
- Login admin dibatasi ketat (`ADMIN_LOGIN_CAPACITY`, default 5 per 15 menit).
- Gambar QRIS maksimal 512 KB, bukti transfer maksimal 1.2 MB, dan hanya
  JPG/PNG/WebP; decoder menolak payload selain raster image supaya endpoint
  upload tidak bisa dipakai sebagai file storage.
- Query publik (`GET /api/qris`) tidak pernah di-cache, jadi QRIS yang diganti
  langsung berlaku.
- Token order (`x-order-token`) hanya hidup di browser pembayar dan tidak pernah
  ditulis ke log atau URL.
- QRIS dan bukti transfer disajikan dari origin sendiri; CSP menolak gambar pihak
  ketiga, jadi tidak ada kebocoran data ke CDN luar.
- Jangan letakkan kontak pribadi pada WebSocket roster atau log.
- Refund/koreksi dilakukan manual: tolak order lalu minta pembayar membuat order
  baru. Tidak ada pengembalian otomatis.

## Kalau mau gratis lagi

Set `REQUIRE_SLOT_PAYMENT=0`. Lobby kembali memakai tombol "Buat room & undang
teman" tanpa checkout, `create` tidak menuntut token, dan halaman checkout tidak
muncul di alur. Semua data order yang sudah ada tetap tersimpan di SQLite.
