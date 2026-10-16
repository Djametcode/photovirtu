// Photovirtu realtime room server.
// HTTP is Express (see app.js); WebSocket is retained for JSON control frames
// and WebRTC signalling. Media never reaches this server: participant video
// stays P2P.
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { createApp, createLimiters } from './app.js'
import {
  ALLOWED_ORIGINS,
  HEARTBEAT_MS,
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
  MAX_PAYLOAD_BYTES,
  MAX_SOCKETS_PER_IP,
  PORT,
  REQUIRE_SLOT_PAYMENT,
  WS_PATH,
} from './config.js'
import { attachPeer } from './protocol.js'
import { sweepRooms } from './rooms.js'
import { clientIp, corsHeaders, newPeerId } from './security.js'
import { expireOrders } from './store/orders.js'

const limiters = createLimiters()
const app = createApp(limiters)
const socketsPerIp = new Map()

// Keep the existing single port: Express handles HTTP routes, while ws handles
// only validated upgrade requests on the same Node HTTP server.
const server = http.createServer(app)
// Bound slow-header/request sockets so a client cannot tie up HTTP resources
// indefinitely before it even reaches the WebSocket or message limiter.
server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS
server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS
server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES })

server.on('upgrade', (req, socket, head) => {
  // Do not let arbitrary paths reach the WebSocket parser. Keeping signalling on
  // one explicit route also makes edge/WAF policies precise.
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  if (pathname !== WS_PATH) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }

  const origin = req.headers.origin ?? ''
  const { allowed } = corsHeaders(origin, req.headers.host ?? '')

  // Browsers send Origin on WS handshakes. Refuse foreign pages before any room
  // code can be probed. Non-browser clients must also supply an allowed origin.
  if (!allowed) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }

  // Reuse Express's proxy-aware request IP handling without routing the upgrade
  // through Express middleware.
  const ip = clientIp(req)
  const active = socketsPerIp.get(ip) ?? 0
  if (active >= MAX_SOCKETS_PER_IP) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
    socket.destroy()
    return
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.ip = ip
    wss.emit('connection', ws, req)
  })
})

wss.on('connection', (ws) => {
  const ip = ws.ip
  socketsPerIp.set(ip, (socketsPerIp.get(ip) ?? 0) + 1)
  ws.isAlive = true
  ws.peer = null
  ws.room = null
  ws.id = newPeerId()

  ws.on('pong', () => {
    ws.isAlive = true
  })

  const deps = {
    joinLimiter: limiters.joinLimiter,
    messageLimiter: limiters.messageLimiter,
    shareLimiter: limiters.shareLimiter,
    sessionLimiter: limiters.sessionLimiter,
    requirePayment: REQUIRE_SLOT_PAYMENT,
  }
  ws.on('message', (raw) => {
    if (!limiters.messageLimiter(ip)) {
      ws.send(JSON.stringify({ type: 'error', code: 'RATE_LIMITED' }))
      return
    }

    let message
    try {
      message = JSON.parse(raw.toString('utf8'))
    } catch {
      ws.send(JSON.stringify({ type: 'error', code: 'BAD_JSON' }))
      return
    }

    // Fast-path liveness so a slow handler cannot stall heartbeats.
    if (message?.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: message.t ?? null }))
      return
    }

    try {
      attachPeer(ws, message, deps)
    } catch (error) {
      const code = error instanceof Error ? error.message : 'HANDLER_ERROR'
      ws.send(JSON.stringify({ type: 'error', code }))
    }
  })

  ws.on('close', () => {
    const remaining = (socketsPerIp.get(ip) ?? 1) - 1
    if (remaining <= 0) socketsPerIp.delete(ip)
    else socketsPerIp.set(ip, remaining)
    ws.cleanup?.()
  })

  // Transport errors are followed by close, which owns cleanup.
  ws.on('error', () => {})
})

// Drop half-open sockets so dead clients do not hold room capacity forever.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate()
      continue
    }
    ws.isAlive = false
    ws.ping()
  }
}, HEARTBEAT_MS)

const sweeper = setInterval(() => {
  sweepRooms()
  for (const limiter of Object.values(limiters)) limiter.sweep?.()
  expireOrders()
}, 5 * 60 * 1000)

function shutdown() {
  clearInterval(heartbeat)
  clearInterval(sweeper)
  for (const ws of wss.clients) ws.close(1001, 'server shutting down')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

server.listen(PORT, () => {
  console.log(`photovirtu room server listening on :${PORT}`)
  console.log(`allowed origins: ${ALLOWED_ORIGINS.join(', ')}`)
  console.log(`slot payments: ${REQUIRE_SLOT_PAYMENT ? 'required (QRIS + admin approval)' : 'disabled (open hosting)'}`)
})
