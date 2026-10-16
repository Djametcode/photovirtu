# Photovirtu — Production Readiness & TikTok Scale Plan

## Status saat ini

Backend saat ini sudah cocok untuk **MVP / private beta**: Express 5 menangani
HTTP, `ws` menangani signalling, dan media berjalan P2P melalui WebRTC.
Keamanan aplikasi dasar sudah ada: invite code berentropi tinggi, host capability
token, origin allowlist, payload cap, batas room, heartbeat, dan token-bucket
rate limit per IP. Room hanya lahir dari **slot berbayar yang sudah diverifikasi
admin**, jadi biaya masuk menjadi gate abuse pertama sekaligus sumber pendapatan.

Namun ini **belum boleh dipromosikan ke jutaan pengguna** dalam bentuk sekarang.
Menaikkan jumlah instance Node saja tidak cukup dan justru akan memecah room
antar-instance.

## Hasil audit mekanisme saat ini

| Komponen | Kondisi | Risiko pada traffic besar | Keputusan produksi |
|---|---|---|---|
| HTTP API | Express 5 + Helmet; hanya `/health` | Kecil, tapi belum ada edge WAF/CDN | Letakkan di balik CDN/WAF dan load balancer |
| WebSocket signalling | `ws`, payload masuk max 2 MB, origin allowlist, socket/IP max 12 | Semua connection/state hanya hidup di satu proses | Gunakan Redis adapter/pub-sub atau signalling service yang sticky dan horizontal |
| Room registry | `Map` in-memory; max 5.000 room/instance | Restart menghapus room; multi-replica tidak saling tahu room | Redis Cluster untuk ephemeral room/presence; TTL atomik |
| Rate limit | Token bucket in-memory per proses | Penyerang cukup pindah instance; limit reset saat restart | Edge limit + Redis rate limit berbasis IP/identity/room |
| Video | WebRTC full mesh, maksimum 8 peserta | Setiap peer mengirim satu upstream per peserta: O(n²) bandwidth/CPU | Untuk room >4 atau target massal, pindah ke SFU (LiveKit/mediasoup/Janus) |
| STUN/TURN | STUN publik Google saja | NAT ketat gagal terhubung; STUN publik bukan SLA produk | Coturn multi-region dengan credential sementara |
| Foto sesi | 4 frame data URI dikirim via WS lalu dibroadcast | Frame besar memakan RAM/event-loop dan bandwidth signalling; 8 peer memperbesar fan-out | Upload langsung ke object storage pakai signed URL, WS hanya mengirim metadata |
| Observability | `/health` saja | Tidak bisa mendeteksi overload, abuse, atau kegagalan join | Metrics, tracing, structured log, alerting, readiness endpoint |
| Abuse identity | Invite-code only | Bot bisa membuat room / membuka socket dari banyak IP | Turnstile pada create/join berisiko, device/session attestation, edge bot rules |
| Slot berbayar | Order QRIS + approval manual admin | Setiap order butuh mata manusia; antrean tidak tidur saat campaign | Webhook pembayaran bertanda tangan (Midtrans/Xendit) sebagai verifikator otomatis, approval manual hanya untuk kasus sengketa |
| Bukti transfer | BLOB di SQLite, dibaca admin | Database produksi menyimpan gambar pelanggan → isu privasi + ukuran | Object storage + signed URL, retention policy hapus bukti setelah verifikasi |

## Bottleneck yang paling penting

### 1. WebRTC mesh bukan arsitektur jutaan pengguna

Mesh adalah pilihan yang benar untuk room kecil karena server tidak menyalurkan
video. Tetapi untuk room berisi `n` orang, tiap browser mengirim/men-decode
hingga `n - 1` stream. Untuk 8 orang berarti hingga 7 upstream dan 7 downstream
per perangkat. Mobile user dari TikTok akan cepat panas, boros kuota, dan gagal
pada jaringan seluler.

**Tahap awal:** pertahankan batas maksimal 4 peserta untuk perangkat mobile.
**Tahap produksi:** gunakan SFU. Browser mengirim satu upstream ke SFU, lalu SFU
meneruskan layer video sesuai kapasitas tiap penerima. Kandidat: LiveKit Cloud
(cepat go-live), LiveKit self-hosted/mediasoup (kontrol dan biaya jangka panjang).

### 2. Frame foto tidak boleh lewat WebSocket pada skala besar

Satu submit saat ini bisa membawa 4 frame, masing-masing hingga 380 KB; payload
mendekati 1.5 MB kemudian disalin ke setiap peserta. Pada 8 peserta, satu ronde
bisa menghasilkan puluhan MB egress dari signalling server dan membentuk antrean
`bufferedAmount` untuk klien lambat.

**Desain target:**

1. Client meminta upload ticket dari API setelah lolos limiter.
2. API mengembalikan signed PUT URL object storage (S3/R2/GCS), batas MIME,
   ukuran, expiry 60–120 detik, dan prefix per room/session/peer.
3. Client upload JPEG/WebP langsung ke storage/CDN.
4. Client mengirim hanya `{sessionId, pose, objectKey, checksum}` melalui WS.
5. Server validasi ownership, jumlah pose, dan checksum; broadcast hanya metadata.
6. Hasil photostrip dibuat client-side dari CDN URLs atau oleh queue worker bila
   perlu file final yang dapat diunduh.
7. Lifecycle policy storage menghapus frame mentah otomatis (mis. 24 jam).

Jangan pernah memberikan bucket write credential permanen ke browser.

### 3. State dan rate limit harus shared

Karena `rooms`, socket count, dan limiter sekarang adalah `Map` process-local,
replica A tidak tahu participant yang tersambung di replica B. Inilah alasan
horizontal autoscaling tidak aman tanpa Redis/signalling fabric.

**Redis minimum schema:**

- `room:{hash}`: metadata room + TTL.
- `room:{hash}:peers`: presence/session participant dengan TTL heartbeat.
- `rate:{scope}:{key}`: atomic token-bucket / sliding-window counter.
- Pub/sub atau Redis Streams untuk event signalling lintas replica.

Jangan simpan invite-code plaintext; tetap gunakan hash seperti implementasi saat
ini. Host token harus hash/terenkripsi jika Redis bisa diakses pihak lain.

## Pertahanan DDoS berlapis

Tidak ada perubahan kode aplikasi yang cukup untuk menahan DDoS volumetrik.
Pertahanan wajib dimulai **sebelum request mencapai Node**.

```
User/TikTok
  -> CDN + WAF + bot management + DDoS mitigation
  -> global/edge rate limits + challenge untuk abuse
  -> load balancer / API gateway (WebSocket support, connection limits)
  -> stateless Express signalling replicas
  -> Redis / queue / object storage / SFU / TURN
```

### Edge/WAF wajib

- Aktifkan CDN/WAF (mis. Cloudflare) dan proxy DNS; jangan expose IP origin.
- Firewall origin hanya menerima traffic dari IP load balancer/CDN dan jaringan
  private internal. Ini penting agar attacker tidak bypass WAF langsung ke `:8787`.
- Rate limit di edge terpisah untuk `GET /health`, HTTP API, dan WebSocket upgrade.
  Beri limit connection creation jauh lebih ketat daripada pesan pada socket.
- Terapkan bot management/challenge adaptif untuk create room dan join attempt;
  jangan challenge heartbeat/media path setelah user lolos.
- Batasi request body, header count/size, URI length, TLS handshake/connection rate,
  concurrent connection/IP, dan WebSocket connection duration di gateway.
- Gunakan managed DDoS protection dari cloud/CDN; jangan mengandalkan Node process.

### Aplikasi wajib

- Pertahankan origin allowlist dan `maxPayload`; origin bukan pengganti auth.
- Pakai rate limit shared Redis berdasarkan kombinasi IP prefix, session/device,
  action (`create`, `join`, `WS upgrade`, `frames`) dan room.
- Beri timeout: upgrade handshake, idle socket, close handshake, serta backpressure
  cap. Klien dengan outbound buffer berlebihan harus diputus untuk melindungi
  event loop.
- Jangan mempercayai `X-Forwarded-For` kecuali ingress hanya dapat diakses melalui
  proxy tepercaya. Konfigurasi `TRUST_PROXY=1` hanya aman bila direct origin traffic
  diblok firewall.
- Validasi template/message schema dengan strict schema validator sebelum diproses.
- Jangan log invite code, host token, signed URL, SDP lengkap, atau data URI foto.

## Deployment yang direkomendasikan

### Tahap 0 — sekarang, private beta

- Satu region, satu replica signalling, maksimum 4 peserta mobile per room.
- Cloudflare/proxy + origin firewall + TLS.
- Managed Redis, object storage signed upload, TURN managed/self-hosted.
- Sentry/OTel logs + dashboard untuk connection, room, join error, dan bandwidth.
- Load test sebelum membuka promo.

### Tahap 1 — soft launch

- Signalling replicas stateless + Redis pub/sub, autoscaling berdasar active WS
  connections, CPU, memory, dan event-loop lag (bukan CPU saja).
- Queue untuk pekerjaan image final; dead-letter queue dan limit concurrency.
- CDN untuk static Vite bundle dan hasil foto; cache immutable asset hash.
- Canary rollout 1–5%; kill switch untuk create room dan upload foto.

### Tahap 2 — TikTok campaign besar

- SFU dan TURN multi-region; routing user ke region terdekat.
- Capacity reservation dengan provider CDN/WAF/SFU sebelum campaign.
- Load/soak test memakai pola nyata: massive landing spike, banyak join salah,
  reconnect mobile, WebSocket churn, dan upload bersamaan.
- SLO/alert: join success, WS connect success, median/p95 signalling latency,
  ICE connected rate, capture completion rate, Redis latency, event-loop lag,
  egress, WAF block/challenge rate.
- Incident runbook dan on-call selama campaign.

## Target kapasitas sebelum promosi

Jangan memakai angka “jutaan” tanpa mengukur peak concurrency. Gunakan ini untuk
sizing:

```
peak concurrent rooms = peak concurrent users / average room occupancy
WS connections        = peak concurrent users
media bandwidth       = ditentukan SFU bitrate/layer, bukan Node signalling
photo storage/day     = completed sessions/day × frame count × average file size
```

Contoh: 1.000.000 daily visitors tidak sama dengan 1.000.000 koneksi bersamaan.
Jika 3% aktif pada puncak, itu 30.000 WebSocket. Jika rata-rata 3 user/room, itu
10.000 room aktif. Capacity test harus membuktikan target peak Anda dengan 2x
headroom sebelum campaign.

## Checklist go/no-go

- [ ] Domain, TLS, HSTS, CDN/WAF, dan origin firewall sudah live.
- [ ] Origin tidak dapat diakses langsung dari Internet.
- [ ] Redis/shared signalling sudah lolos failover test.
- [ ] Frame foto pindah dari WebSocket ke signed direct-to-storage upload.
- [ ] TURN credentials sementara dan rotasi secret aktif.
- [ ] SFU dipakai atau room mobile dibatasi 4 participant.
- [ ] Redis/edge limiter, abuse challenge, dan quota per room aktif.
- [ ] Metrics, alert, dashboard, tracing, dan runbook sudah diuji.
- [ ] Load/soak/failure test memenuhi SLO dengan 2x proyeksi traffic puncak.
- [ ] Privacy policy, retention/deletion image, dan consent camera sudah siap.

## Perubahan yang sengaja belum dilakukan

Migrasi Redis, object storage, SFU/TURN, CDN/WAF, dan autoscaling membutuhkan
pilihan cloud/provider, domain, region, budget, serta kredensial. Mereka tidak
boleh dipasang secara spekulatif atau dengan endpoint/credential palsu. Setelah
provider dipilih, implementasi harus dilakukan sebagai tahap terukur, dimulai
dengan Redis + signed upload karena keduanya menghilangkan dua bottleneck terbesar.
