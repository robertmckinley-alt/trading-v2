let databaseClient = null;
let schemaReady = null;

export function isCloudJournalConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

async function getDatabase() {
  if (!isCloudJournalConfigured()) {
    throw new Error('Cloud journal storage is not configured.');
  }
  if (!databaseClient) {
    const { neon } = await import('@neondatabase/serverless');
    databaseClient = neon(process.env.DATABASE_URL);
  }
  return databaseClient;
}

async function ensureSchema() {
  if (!schemaReady) {
    const sql = await getDatabase();
    schemaReady = sql`
      CREATE TABLE IF NOT EXISTS trading_journal_entries (
        id TEXT PRIMARY KEY,
        trade_date DATE,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

export function validateJournalEntries(entries) {
  if (!Array.isArray(entries) || entries.length > 250) {
    throw new Error('Journal sync accepts up to 250 trades at a time.');
  }

  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id.trim()) {
      throw new Error('Every journal trade must include a non-empty id.');
    }
    const serialized = JSON.stringify(entry);
    if (serialized.length > 100_000) {
      throw new Error(`Journal trade ${entry.id} is too large.`);
    }
    return JSON.parse(serialized);
  });
}

export async function listJournalEntries(limit = 500) {
  await ensureSchema();
  const sql = await getDatabase();
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 1000);
  const rows = await sql`
    SELECT payload
    FROM trading_journal_entries
    ORDER BY COALESCE(payload->>'createdAt', trade_date::text) DESC, id DESC
    LIMIT ${safeLimit}
  `;
  return rows.map((row) => row.payload);
}

export async function upsertJournalEntries(rawEntries) {
  const entries = validateJournalEntries(rawEntries);
  if (!entries.length) return 0;
  await ensureSchema();
  const sql = await getDatabase();
  const payload = JSON.stringify(entries);
  const result = await sql`
    INSERT INTO trading_journal_entries (id, trade_date, payload, created_at, updated_at)
    SELECT
      entry->>'id',
      CASE WHEN COALESCE(entry->>'date', '') ~ '^\\d{4}-\\d{2}-\\d{2}$'
        THEN (entry->>'date')::date
        ELSE NULL
      END,
      entry,
      NOW(),
      NOW()
    FROM jsonb_array_elements(${payload}::jsonb) AS entry
    ON CONFLICT (id) DO UPDATE SET
      trade_date = EXCLUDED.trade_date,
      payload = EXCLUDED.payload,
      updated_at = NOW()
    RETURNING id
  `;
  return result.length;
}

export async function clearJournalEntries() {
  await ensureSchema();
  const sql = await getDatabase();
  const result = await sql`DELETE FROM trading_journal_entries RETURNING id`;
  return result.length;
}
