// Single SQLite handle plus the schema, so every store shares one connection
// and one migration list. node:sqlite keeps the deployment dependency-free; a
// multi-replica deployment must move these tables to a managed SQL database.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DB_PATH } from './config.js'

mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new DatabaseSync(DB_PATH)

// The busy handler must be installed before the WAL switch: changing journal
// mode needs a lock, and a second process (a rolling deploy, a test harness)
// would otherwise fail instantly with SQLITE_BUSY.
db.exec('PRAGMA busy_timeout = 5000')

function initSchema() {
  db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  -- One row per paid slot. A slot becomes usable only after the host uploads a
  -- payment proof and an admin approves it; the room then consumes it once.
  CREATE TABLE IF NOT EXISTS slot_orders (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    requester_name TEXT NOT NULL,
    event_name TEXT NOT NULL,
    template_id TEXT NOT NULL,
    capacity INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN (
      'PENDING_PAYMENT','PENDING_REVIEW','APPROVED','ACTIVATED','REJECTED','EXPIRED','CANCELLED'
    )),
    created_at INTEGER NOT NULL,
    proof_at INTEGER,
    reviewed_at INTEGER,
    reviewed_by TEXT,
    review_note TEXT,
    activated_at INTEGER,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS slot_orders_status_created ON slot_orders(status, created_at);

  -- Payment proofs are stored beside the order so a deleted order cannot leave
  -- an orphan file behind and no upload path is reachable without a row.
  CREATE TABLE IF NOT EXISTS order_proofs (
    order_id TEXT PRIMARY KEY REFERENCES slot_orders(id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    bytes BLOB NOT NULL,
    uploaded_at INTEGER NOT NULL
  );

  -- Operator-editable settings: QRIS merchant details and the slot price.
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Single-row table holding the merchant QRIS image the operator uploaded.
  CREATE TABLE IF NOT EXISTS payment_qris (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    bytes BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  );
`)
}

// A second process may hold the schema lock for a moment during deploy; retry
// instead of crashing the boot on a transient SQLITE_BUSY.
for (let attempt = 0; ; attempt += 1) {
  try {
    initSchema()
    break
  } catch (error) {
    if (attempt >= 4 || !/locked|busy/i.test(String(error?.message ?? ''))) throw error
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250 * (attempt + 1))
  }
}

// BEGIN IMMEDIATE makes read-check-write sequences atomic, so a slot cannot be
// consumed or reviewed twice by concurrent requests.
export function tx(work) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
