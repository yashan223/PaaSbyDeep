import '../config/env.js';
import { initDb, getDb, closeDb, formatDbError } from './database.js';

async function migrate() {
  try {
    await initDb();
    const sql = getDb();

    const columns = await sql`
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `;

    const grouped = {};
    for (const col of columns) {
      if (!grouped[col.table_name]) grouped[col.table_name] = [];
      grouped[col.table_name].push(`${col.column_name} (${col.data_type}${col.is_nullable === 'NO' ? ', NOT NULL' : ''})`);
    }

    console.log('\n[Migrate] Database public schema:');
    for (const [table, cols] of Object.entries(grouped)) {
      console.log(`  - ${table}:`);
      for (const c of cols) console.log(`      • ${c}`);
    }
  } finally {
    await closeDb().catch(() => {});
  }
}

migrate().catch((err) => {
  console.error('[Migrate] Failed:', formatDbError(err));
  process.exit(1);
});
