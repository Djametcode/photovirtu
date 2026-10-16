// Real browser proof of the shared group photo: two independent participants
// join the same room, the host starts a synced session, both capture, and each
// client composes a strip containing BOTH people (not just themselves).
import { chromium } from 'playwright-core'

const APP = process.env.APP_URL ?? 'http://127.0.0.1:4173'
const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox']

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', args: ARGS }).catch(() => chromium.launch({ args: ARGS }))
  const hostCtx = await browser.newContext({ permissions: ['camera'] })
  const guestCtx = await browser.newContext({ permissions: ['camera'] })
  const host = await hostCtx.newPage()
  const guest = await guestCtx.newPage()

  const errors = []
  for (const [label, page] of [['host', host], ['guest', guest]]) {
    page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`))
  }

  // --- Host creates the room ------------------------------------------------
  await host.goto(APP)
  await host.click('.primary-button')
  await host.waitForSelector('.template-grid')
  await host.click('text=Lanjut ke room')
  await host.waitForSelector('.lobby-card')
  await host.fill('#lobby-name', 'HostPix')
  await host.click('text=Buat room & undang teman')
  await host.waitForSelector('.room-page', { timeout: 20000 })
  const code = (await host.locator('.code-value').innerText()).trim()
  check('host created a room with invite code', /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code), `code=${code}`)

  // --- Guest joins ---------------------------------------------------------
  await guest.goto(APP)
  await guest.click('text=Gabung room')
  await guest.waitForSelector('.lobby-card')
  await guest.click('button[role="tab"]:has-text("Gabung")')
  await guest.fill('#lobby-name', 'GuestPix')
  await guest.fill('#lobby-code', code)
  await guest.click('text=Masuk ke room')
  await guest.waitForSelector('.room-page', { timeout: 20000 })
  check('guest joined the room', await guest.locator('.room-page').isVisible())

  await host.waitForFunction(() => document.querySelector('.room-live')?.textContent?.includes('2 orang'), null, { timeout: 15000 })
  check('both participants see each other', (await host.locator('.room-live').innerText()).includes('2 orang'))

  // --- Host starts the synced group session --------------------------------
  const startBtn = host.locator('button:has-text("Mulai sesi bareng"), button:has-text("Lanjut ambil foto")').first()
  await startBtn.click()

  // BOTH clients must land on the shared capture screen, without the guest
  // doing anything: this is the proof that the session is synchronised.
  await host.waitForSelector('.shared-capture', { timeout: 15000 })
  const guestPulled = await guest.waitForSelector('.shared-capture', { timeout: 15000 }).then(() => true).catch(() => false)
  check('guest is pulled into the shared session automatically', guestPulled)

  const banner = await host.locator('.shared-badge').innerText().catch(() => '')
  check('capture screen announces a group session', /FOTO BARENG/.test(banner), `banner=${banner}`)
  check('banner reports the real head count (2)', /2 ORANG/.test(banner), `banner=${banner}`)

  // --- Both clients auto-capture 4 poses ----------------------------------
  // The capture screen unmounts the moment the session completes, so polling it
  // is racy by design. Capture is proven by the composed strip further down
  // (4 pose rows x 2 people = 8 images), which only exists if every client
  // actually produced all four frames. Here we just confirm both clients left
  // the capture screen under their own steam, with no manual shutter press.
  const leftCapture = (page) => page.waitForFunction(
    () => document.querySelectorAll('.shared-thumb').length === 0 || document.querySelector('.group-strip') !== null,
    null,
    { timeout: 45000, polling: 400 },
  ).then(() => true).catch(() => false)

  const [hostDone, guestDone] = await Promise.all([leftCapture(host), leftCapture(guest)])
  check('host completed the automatic capture round', hostDone)
  check('guest completed the automatic capture round', guestDone)

  // --- Both clients must reach the composed group strip -------------------
  const toResult = (page) => page.waitForSelector('.group-strip', { timeout: 30000, polling: 400 }).then(() => true).catch(() => false)
  const [hostResult, guestResult] = await Promise.all([toResult(host), toResult(guest)])
  check('host reaches the composed group strip', hostResult)
  check('guest reaches the composed group strip', guestResult)

  // --- THE key assertion: each strip contains BOTH participants -----------
  const countFaces = (page) => page.evaluate(() => {
    const cells = [...document.querySelectorAll('.group-strip .group-cell img')]
    return { totalImages: cells.length, poses: document.querySelectorAll('.group-strip .group-pose').length }
  })

  const hostSees = await countFaces(host)
  const guestSees = await countFaces(guest)

  // 4 poses x 2 people = 8 images per strip.
  check('host sees 2 people in every pose (8 images)', hostSees.totalImages === 8, JSON.stringify(hostSees))
  check('guest sees 2 people in every pose (8 images)', guestSees.totalImages === 8, JSON.stringify(guestSees))
  check('strip has 4 pose rows', hostSees.poses === 4 && guestSees.poses === 4, `host=${hostSees.poses} guest=${guestSees.poses}`)

  // The two strips must be equivalent: same shape, same participants.
  check('both clients compose the SAME group strip', hostSees.totalImages === guestSees.totalImages && hostSees.poses === guestSees.poses)

  const names = await host.locator('.group-names').innerText().catch(() => '')
  check('strip credits both participants by name', names.includes('HostPix') && names.includes('GuestPix'), `names=${names}`)

  check('no uncaught page errors', errors.length === 0, errors.join(' | '))

  await browser.close()

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} group browser checks passed`)
  if (failed.length) {
    console.log('FAILED: ' + failed.map((f) => f.name).join(' | '))
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('harness error:', e.message)
  process.exit(2)
})
