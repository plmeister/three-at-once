import { DatabaseSync } from 'node:sqlite'

interface CacheRecord {
  value: any
  expires: number
}

export interface Cache {
  get(key: string): any
  set(key: string, value: unknown, ttlMs: number): void
  readonly size: number
}

export function createCache(
  maxEntries = 500,
  { file = null }: { file?: string | null } = {}
): { get(key: string): any; set(key: string, value: unknown, ttlMs: number): void; readonly size: number } {
  const store = new Map<string, CacheRecord>()
  let db: DatabaseSync | null = null
  if (file) {
    try {
      db = new DatabaseSync(file)
      db.exec(
        'CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, expires INTEGER NOT NULL, value TEXT NOT NULL)'
      )
    } catch {
      db = null // DB unusable (e.g. unwritable mount) — fall back to in-memory only
    }
  }

  function expired(value: CacheRecord): boolean {
    return Date.now() > value.expires
  }

  function fromDb(key: string): { value: any; expires: number } | undefined {
    if (!db) return undefined
    try {
      const row = db.prepare('SELECT expires, value FROM cache WHERE k = ?').get(key) as
        | { expires: number; value: string }
        | undefined
      if (!row) return undefined
      const ttl = row.expires - Date.now()
      if (ttl <= 0) {
        db.prepare('DELETE FROM cache WHERE k = ?').run(key)
        return undefined
      }
      return { value: JSON.parse(row.value), expires: row.expires }
    } catch {
      return undefined
    }
  }

  function pruneDb() {
    if (!db) return
    try {
      db.prepare('DELETE FROM cache WHERE expires <= ?').run(Date.now())
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM cache').get() as { n: number }
      if (n >= maxEntries) {
        db.prepare(
          'DELETE FROM cache WHERE k IN (SELECT k FROM cache ORDER BY expires ASC LIMIT ?)'
        ).run(Math.ceil((n - maxEntries) / 2) + 1)
      }
    } catch {
      /* ignore */
    }
  }

  return {
    get(key: string) {
      const hit = store.get(key)
      if (hit) {
        if (expired(hit)) {
          store.delete(key)
          return undefined
        }
        return hit.value
      }
      const fromDisk = fromDb(key)
      if (fromDisk) store.set(key, fromDisk)
      return fromDisk?.value
    },
    set(key: string, value: unknown, ttlMs: number) {
      if (store.size >= maxEntries) {
        const oldest = [...store.entries()].sort((a, b) => a[1].expires - b[1].expires)[0]
        store.delete(oldest[0])
      }
      const rec: CacheRecord = { value, expires: Date.now() + ttlMs }
      store.set(key, rec)
      // only durable data (static info / everything that isn't a live feed) goes to disk;
      // short-TTL entries like departures stay in memory to avoid SQLite write churn
      if (db && ttlMs >= 60_000) {
        try {
          db.prepare(
            'INSERT INTO cache (k, expires, value) VALUES (?, ?, ?) ' +
              'ON CONFLICT(k) DO UPDATE SET expires = excluded.expires, value = excluded.value'
          ).run(key, rec.expires, JSON.stringify(value))
        } catch {
          /* non-serialisable value or DB error — keep the in-memory copy */
        }
      }
    },
    get size() {
      if (!db) return store.size
      try {
        const { n } = db.prepare('SELECT COUNT(*) AS n FROM cache').get() as { n: number }
        return n
      } catch {
        return store.size
      }
    },
  }
}
