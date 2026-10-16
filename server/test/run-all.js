import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readdir, rm } from 'node:fs/promises'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '..', 'src', 'index.js')
const port = 8920
const env = {
  ...process.env,
  PORT: String(port),
  ALLOWED_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173',
  // The suite exercises the open-hosting path; payments.js covers the gate.
  REQUIRE_SLOT_PAYMENT: '0',
  SLOT_DB_PATH: join(here, '..', 'data', 'suite-test.sqlite'),
  JOIN_CAPACITY: '500',
  JOIN_REFILL_PER_SEC: '100',
  MSG_CAPACITY: '2000',
  MSG_REFILL_PER_SEC: '1000',
  SESSION_CAPACITY: '100',
  SESSION_REFILL_PER_SEC: '100',
}

const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'inherit'] })
let output = ''
child.stdout.on('data', (chunk) => {
  output += chunk.toString()
})

function stop() {
  if (child.exitCode === null) child.kill('SIGTERM')
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server did not start')), 8000)
    const onData = () => {
      if (!output.includes(`listening on :${port}`)) return
      clearTimeout(timer)
      child.stdout.off('data', onData)
      resolve()
    }
    child.stdout.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`test server exited with code ${code}`))
    })
  })
}

async function run() {
  await waitForServer()
  for (const file of ['e2e.js', 'group.js', 'security.js']) {
    // Each file gets its own SQLite file: security.js boots a second server
    // process, and two writers must not fight over one test database.
    const suiteEnv = {
      ...process.env,
      SERVER_URL: `ws://127.0.0.1:${port}/ws`,
      SLOT_DB_PATH: join(here, '..', 'data', `suite-${file.replace(/\W+/g, '-')}.sqlite`),
    }
    const result = await new Promise((resolve) => {
      const suite = spawn(process.execPath, [join(here, file)], { env: suiteEnv, stdio: 'inherit' })
      suite.once('exit', (code, signal) => resolve({ code: code ?? 1, signal }))
    })
    if (result.code !== 0) throw new Error(`${file} failed (${result.signal ?? result.code})`)
  }
  await new Promise((resolve, reject) => {
    const payments = spawn(process.execPath, [join(here, 'payments.js')], { env: process.env, stdio: 'inherit' })
    payments.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`payments.js failed (${code})`)))
  })
}

try {
  await run()
} finally {
  stop()
  // Leave no test databases behind: they hold no fixtures worth keeping.
  const dataDir = join(here, '..', 'data')
  const entries = await readdir(dataDir).catch(() => [])
  await Promise.all(
    entries
      .filter((name) => name.startsWith('suite-') || name.startsWith('suite.') || name.startsWith('payments-test'))
      .map((name) => rm(join(dataDir, name), { force: true })),
  )
}
