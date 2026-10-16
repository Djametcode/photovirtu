// Real end-to-end: drives the actual built UI in two independent browser
// contexts and verifies they discover each other through the room server.
import { chromium } from 'playwright-core'

const APP = process.env.APP_URL ?? 'http://127.0.0.1:4173'
const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function launchArgs() {
  return ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox']
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', args: launchArgs() }).catch(() => chromium.launch({ args: launchArgs() }))
  const hostCtx = await browser.newContext({ permissions: ['camera', 'microphone'] })
  const guestCtx = await browser.newContext({ permissions: ['camera', 'microphone'] })
  const host = await hostCtx.newPage()
  const guest = await guestCtx.newPage()

  const errors = []
  for (const [label, page] of [['host', host], ['guest', guest]]) {
    page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`))
  }

  await host.goto(APP)
  await host.waitForSelector('.hero h1')
  check('landing page renders', (await host.locator('.hero h1').innerText()).includes('Foto bareng'))

  // Host: setup -> lobby
  await host.click('.primary-button')
  await host.waitForSelector('.template-grid')
  const templateCount = await host.locator('.template-option').count()
  check('all templates render in picker', templateCount === 19, `count=${templateCount}`)

  await host.click('text=Lanjut ke room')
  await host.waitForSelector('.lobby-card')
  await host.fill('#lobby-name', 'HostPix')
  await host.click('text=Buat room & undang teman')

  await host.waitForSelector('.room-page', { timeout: 15000 })
  const hostCode = (await host.locator('.code-value').innerText()).trim()
  check('host reaches live room with an invite code', /^[0-9A-HJKMNP-TV-Z]{8}$/.test(hostCode), `code=${hostCode}`)

  // Guest: join with that code
  await guest.goto(APP)
  await guest.click('text=Gabung room')
  await guest.waitForSelector('.lobby-card')
  await guest.click('button[role="tab"]:has-text("Gabung")')
  await guest.fill('#lobby-name', 'GuestPix')
  await guest.fill('#lobby-code', hostCode)
  await guest.click('text=Masuk ke room')

  await guest.waitForSelector('.room-page', { timeout: 15000 })
  check('guest joins with the invite code', await guest.locator('.room-page').isVisible())

  // Both sides must see 2 participants
  await host.waitForFunction(() => document.querySelector('.room-live')?.textContent?.includes('2 orang'), null, { timeout: 15000 })
  check('host sees 2 participants', (await host.locator('.room-live').innerText()).includes('2 orang'))
  check('guest sees 2 participants', (await guest.locator('.room-live').innerText()).includes('2 orang'))
  check('guest roster shows host', (await guest.locator('.roster').innerText()).includes('HostPix'))
  check('host roster shows guest', (await host.locator('.roster').innerText()).includes('GuestPix'))

  // WebRTC: real media flowing between the two contexts
  const hostVideoReady = await host.waitForFunction(() => {
    const vids = [...document.querySelectorAll('.peer-tile video')]
    return vids.some((v) => v.srcObject instanceof MediaStream && v.videoWidth > 0)
  }, null, { timeout: 25000 }).then(() => true).catch(() => false)
  check('local camera produces frames', hostVideoReady)

  // WebRTC: the local tile carries class 'mirror'; the remote tile does not.
  // Poll from the driver side with evaluate(): waitForFunction's default
  // polling is rAF-driven, which Chrome suspends in background contexts.
  const probeRemote = () => guest.evaluate(() => {
    const remoteVideos = [...document.querySelectorAll('.peer-tile video')].filter((v) => !v.classList.contains('mirror'))
    return remoteVideos.map((v) => {
      const s = v.srcObject
      const track = s instanceof MediaStream ? s.getVideoTracks()[0] : null
      return {
        hasStream: s instanceof MediaStream,
        tracks: s instanceof MediaStream ? s.getVideoTracks().length : 0,
        audioTracks: s instanceof MediaStream ? s.getAudioTracks().length : 0,
        readyState: track?.readyState ?? null,
        trackMuted: track?.muted ?? null,
        width: v.videoWidth,
        paused: v.paused,
        tileCount: document.querySelectorAll('.peer-tile').length,
      }
    })
  })

  let remoteProbe = await probeRemote()
  const deadline = Date.now() + 30000
  while (Date.now() < deadline && !remoteProbe.some((p) => p.hasStream && p.tracks > 0 && p.width > 0)) {
    await sleep(500)
    remoteProbe = await probeRemote()
  }
  check('P2P remote video negotiated between peers', remoteProbe.some((p) => p.hasStream && p.tracks > 0 && p.width > 0), JSON.stringify(remoteProbe))
  check('P2P remote audio negotiated between peers', remoteProbe.some((p) => p.hasStream && p.audioTracks > 0), JSON.stringify(remoteProbe))

  // If negotiation failed, dump the real WebRTC state instead of guessing.
  if (!remoteProbe.some((p) => p.hasStream && p.tracks > 0 && p.width > 0)) {
    const hostDebug = await host.evaluate(() => window.__photovirtuDebug?.() ?? null)
    const guestDebug = await guest.evaluate(() => window.__photovirtuDebug?.() ?? null)
    console.log('   host debug:', JSON.stringify(hostDebug))
    console.log('   guest debug:', JSON.stringify(guestDebug))
  }

  const peerState = await guest.evaluate(async () => {
    const tiles = [...document.querySelectorAll('.peer-tile')]
    const vids = tiles.map((t) => t.querySelector('video')).filter(Boolean)
    return vids.map((v) => ({
      hasStream: v.srcObject instanceof MediaStream,
      tracks: v.srcObject instanceof MediaStream ? v.srcObject.getVideoTracks().length : 0,
      w: v.videoWidth,
    }))
  })
  check('remote tile carries a live video track', peerState.some((p) => p.hasStream && p.tracks > 0), JSON.stringify(peerState))

  // Wrong code must be refused in the real UI
  const badCtx = await browser.newContext()
  const bad = await badCtx.newPage()
  await bad.goto(APP)
  await bad.click('text=Gabung room')
  await bad.waitForSelector('.lobby-card')
  await bad.click('button[role="tab"]:has-text("Gabung")')
  await bad.fill('#lobby-name', 'BadActor')
  await bad.fill('#lobby-code', 'ZZZZZZZZ')
  await bad.click('text=Masuk ke room')
  await bad.waitForSelector('.lobby-error', { timeout: 10000 })
  const errText = await bad.locator('.lobby-error').innerText()
  check('bad invite code shows an error, stays out of room', errText.includes('tidak ditemukan'), `msg=${errText}`)
  check('bad actor never reaches the room', (await bad.locator('.room-page').count()) === 0)
  await badCtx.close()

  // Host kick ejects the guest
  const kickBtn = host.locator('.roster-kick').first()
  if (await kickBtn.count()) {
    await kickBtn.click()
    await guest.waitForSelector('.lobby-page, .site-shell', { timeout: 10000 })
    check('kicked guest is returned to a safe screen', (await guest.locator('.room-page').count()) === 0)
  } else {
    check('kicked guest is returned to a safe screen', false, 'no kick button rendered for host')
  }

  check('no uncaught page errors', errors.length === 0, errors.join(' | '))

  await browser.close()

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`)
  if (failed.length) {
    console.log('FAILED: ' + failed.map((f) => f.name).join(' | '))
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('harness error:', e.message)
  process.exit(2)
})
