# Deploy Photovirtu

## Production shape

The safest current release is a **single Node instance** behind an HTTPS reverse proxy/CDN. The Node process serves the built Vite app, REST API, and WebSocket endpoint on one origin:

- App and admin: `/` and `/admin`
- REST: `/api/*`
- WebSocket: `/ws`
- Health checks: `/health` and `/ready`

Room state, admin sessions, and rate limits are process-local; SQLite stores slot orders, the merchant QRIS image, and payment proofs. Do not run multiple replicas until those states move to shared infrastructure.

## Build and start

Use Node 22.5+ on Linux (`node:sqlite` is required) and install from lockfiles:

```bash
npm ci
npm --prefix server ci
npm run build
cp .env.example .env
# Edit .env, then export it with your process manager.
npm start
```

The build has no API host baked in: the app calls the origin that serves it. Only set `VITE_API_BASE` when the API intentionally lives on another host, and remember to rebuild afterwards.

## Environment

| Variable | Default | Why it matters |
|---|---|---|
| `NODE_ENV` | `development` | `production` turns on `Secure` cookies and gates hosting by default |
| `PORT` | `8787` | HTTP + WebSocket port |
| `ALLOWED_ORIGINS` | localhost:5173 | Comma-separated browser origins allowed for REST and the WebSocket handshake |
| `ADMIN_PASSWORD` | — | Long random password for `/admin`; without it the admin surface returns 404 |
| `REQUIRE_SLOT_PAYMENT` | `1` when `NODE_ENV=production`, else `0` | Host must own an approved slot before a room can be created |
| `SLOT_PRICE` | `25000` | Default nominal; the admin dashboard can override it at runtime |
| `CURRENCY` | `IDR` | Currency label for price formatting |
| `MERCHANT_NAME` | `Photovirtu` | Default merchant name shown under the QRIS image |
| `PAYMENT_INSTRUCTIONS` | built-in | Default instruction text above the QRIS |
| `ORDER_TTL_MS` | 7 days | How long an unpaid/unreviewed order stays valid |
| `MAX_PROOF_BYTES` | `1200000` | Payment-proof upload cap |
| `MAX_QRIS_BYTES` | `512000` | Merchant QRIS upload cap |
| `SLOT_DB_PATH` | `server/data/photovirtu.sqlite` | SQLite file for orders, settings, QRIS, proofs (`PILOT_DB_PATH` is still honoured as a fallback) |
| `TRUST_PROXY` | `0` | Set to `1` only when exactly one trusted proxy supplies the client address |

`REQUIRE_SLOT_PAYMENT=1` is required for a paid public site: hosts must pay (QRIS transfer + proof upload) and receive admin approval before a realtime room can be created. Set a long random `ADMIN_PASSWORD`, configure the exact HTTPS origin in `ALLOWED_ORIGINS`, and manage orders at `/admin`.

Before the first paid order, log in to `/admin` and upload the merchant **QRIS image** (PNG/JPG/WebP, max 500 KB) plus the nominal. Checkout shows a warning instead of a QR code while no image is uploaded.

## Reverse proxy requirements

- Terminate TLS and proxy HTTP plus WebSocket upgrades to `127.0.0.1:8787`.
- Preserve the `Origin` header and allow WebSocket upgrade on `/ws`.
- Do not expose port 8787 publicly; firewall it to the proxy only.
- Add edge rate limits for `/api/orders`, `/api/orders/*/proof`, `/api/admin/login`, and `/ws`.
- Set `TRUST_PROXY=1` only when the origin is unreachable directly and one trusted proxy supplies the client address.
- Back up the SQLite database and restrict `server/data` permissions: it holds the QRIS image and every payment proof. For more than one replica, replace SQLite and in-memory room/session state first.

## Go-live checks

1. `npm run build && npm run lint`
2. `npm --prefix server test` with the test server harness described in the repository.
3. Log in to `/admin`, upload the QRIS image, and set the nominal. Placing a test order must show that exact image and price in checkout.
4. Pay a test order end to end: proof upload → admin approval → room opens → the invite code lets a second browser join for free.
5. Verify `/admin` loads on a direct refresh and the session cookie is `HttpOnly` + `Secure` + `SameSite=Strict`.
6. Verify camera/microphone permissions over HTTPS on mobile.
7. Configure CDN/WAF, origin firewall, monitoring, privacy policy, image retention, TURN, and load testing. See `PRODUCTION_READINESS.md` for the remaining scale work.

This code is suitable for a controlled single-instance deployment after those infrastructure checks; it is not yet a multi-region or mass-traffic architecture.
