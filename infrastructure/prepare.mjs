import pg from "pg";

// Provision through the maintenance database; never reset existing test or playground data.
const database = process.env.KESTREL_TEST_DATABASE ?? "kestrel_test";
if (!/^kestrel_test(?:_[a-z0-9_]+)?$/.test(database)) {
  throw new Error("The managed test database must be kestrel_test or kestrel_test_<suffix>.");
}
const pool = new pg.Pool({
  host: process.env.DB_HOST ?? "127.0.0.1",
  port: Number(process.env.DB_PORT ?? process.env.KESTREL_POSTGRES_PORT ?? 55432),
  user: process.env.DB_USER ?? "postgres",
  password: process.env.DB_PASSWORD ?? "postgres",
  database: "postgres",
});
try {
  const existing = await pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
  if (existing.rowCount === 0) {
    await pool.query(`CREATE DATABASE "${database}"`);
  }
  console.info(`Framework test database ready: ${database}`);
} finally {
  await pool.end();
}
