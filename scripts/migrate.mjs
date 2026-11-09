import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";

const connection =
  process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
if (!connection)
  throw new Error(
    "Set POSTGRES_URL_NON_POOLING in the private .env.local file.",
  );
const url = new URL(connection);
for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
  url.searchParams.delete(key);
const ssl = { rejectUnauthorized: true };
if (process.env.PGSSLROOTCERT)
  ssl.ca = await fs.readFile(process.env.PGSSLROOTCERT, "utf8");
const client = new pg.Client({
  connectionString: url.toString(),
  ssl,
  connectionTimeoutMillis: 15000,
});
try {
  await client.connect();
  await client.query("begin");
  await client.query(
    "select pg_advisory_xact_lock(hashtext('gardens_schema_migrations'))",
  );
  await client.query(`create table if not exists public.garden_schema_migrations (
    name text primary key, checksum text not null, applied_at timestamptz not null default now()
  ); alter table public.garden_schema_migrations enable row level security;
  revoke all on public.garden_schema_migrations from public, anon, authenticated;`);
  const folder = new URL("../supabase/migrations/", import.meta.url);
  for (const name of (await fs.readdir(folder))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const sql = (await fs.readFile(new URL(name, folder), "utf8")).replace(
      /\r\n/g,
      "\n",
    );
    const checksum = createHash("sha256").update(sql).digest("hex");
    const prior = await client.query(
      "select checksum from public.garden_schema_migrations where name=$1",
      [name],
    );
    if (prior.rowCount) {
      if (prior.rows[0].checksum !== checksum)
        throw new Error(
          `Previously applied migration changed: ${name}. Add a new migration instead.`,
        );
      continue;
    }
    await client.query(sql);
    await client.query(
      "insert into public.garden_schema_migrations(name,checksum) values($1,$2)",
      [name, checksum],
    );
    console.log(`Applied ${name}`);
  }
  await client.query("commit");
  console.log("Database migrations are current.");
} catch (error) {
  await client.query("rollback").catch(() => {});
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
