// Express assembly: security headers, one strict origin policy, the two API
// routers, and the built SPA. The WebSocket server is wired in index.js.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import express from 'express'
import helmet from 'helmet'
import { DIST_DIR, LIMITS, NODE_ENV } from './config.js'
import { roomCount } from './rooms.js'
import { adminRoutes } from './routes/admin.js'
import { publicRoutes } from './routes/public.js'
import { corsHeaders, createRateLimiter } from './security.js'

// Uploaded images are the only large bodies the API accepts; everything else
// stays on an 8kb JSON budget so a huge payload cannot be used as a toy.
const LARGE_BODY_PATHS = [/^\/api\/orders\/[^/]+\/proof$/, /^\/api\/admin\/settings\/qris$/]

export function createLimiters() {
  return {
    joinLimiter: createRateLimiter(LIMITS.join),
    messageLimiter: createRateLimiter(LIMITS.message),
    shareLimiter: createRateLimiter(LIMITS.share),
    sessionLimiter: createRateLimiter(LIMITS.session),
    orderCreateLimiter: createRateLimiter(LIMITS.orderCreate),
    proofLimiter: createRateLimiter(LIMITS.proof),
    adminLoginLimiter: createRateLimiter(LIMITS.adminLogin),
  }
}

export function createApp(limiters) {
  const app = express()
  const jsonSmall = express.json({ limit: '8kb', type: 'application/json' })
  const jsonLarge = express.json({ limit: '2mb', type: 'application/json' })

  // Never accept X-Forwarded-For unless deployment explicitly sits behind a
  // trusted reverse proxy. This prevents clients from choosing their own IP and
  // bypassing per-IP limits in direct deployments.
  app.set('trust proxy', process.env.TRUST_PROXY === '1')
  app.disable('x-powered-by')
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        // QRIS and payment proofs are served by this server, never a third party.
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }))

  // Explicit CORS keeps the same strict policy for REST endpoints as for the
  // WebSocket upgrade. It never reflects untrusted origins.
  app.use((req, res, next) => {
    const origin = req.get('origin') ?? ''
    const { allowed, headers } = corsHeaders(origin, req.get('host') ?? '')
    res.set(headers)
    if (origin && !allowed) return res.status(403).json({ error: 'origin_not_allowed' })
    if (req.method === 'OPTIONS') return res.status(204).end()
    return next()
  })
  app.use((req, res, next) => (LARGE_BODY_PATHS.some((pattern) => pattern.test(req.path)) ? jsonLarge : jsonSmall)(req, res, next))

  app.use('/api/admin', adminRoutes(limiters))
  app.use('/api', publicRoutes(limiters))
  app.get('/health', (_req, res) => res.status(200).json({ ok: true, rooms: roomCount(), uptime: process.uptime() }))
  // Used by a load balancer to decide whether this process may receive new work.
  // Dependency checks belong here once the SQLite store moves to Redis/a cluster.
  app.get('/ready', (_req, res) => res.status(200).json({ ok: true }))

  app.use((error, _req, res, next) => {
    if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'bad_json' })
    // express.json rejects an oversized upload before any route sees it.
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'IMAGE_TOO_LARGE' })
    return next(error)
  })

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' })
  })

  if (existsSync(join(DIST_DIR, 'index.html'))) {
    app.use(express.static(DIST_DIR, { index: false, maxAge: NODE_ENV === 'production' ? '1h' : 0 }))
    app.get('*path', (_req, res) => res.sendFile(join(DIST_DIR, 'index.html')))
  } else {
    app.use((_req, res) => res.status(404).json({ error: 'not_found' }))
  }

  return app
}
