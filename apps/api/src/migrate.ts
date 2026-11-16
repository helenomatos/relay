import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Missing env var DATABASE_URL");

const dir = process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "db/migrations");
const sql = postgres(url, { max: 1, onnotice: () => {} });

// An advisory lock makes it safe to run several migrators at once.
await sql`select pg_advisory_lock(7271)`;
try {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const [done] = await sql`select 1 from schema_migrations where name = ${file}`;
    if (done) continue;
    const ddl = await readFile(path.join(dir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(ddl);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
    console.log(`applied ${file}`);
  }
  console.log("migrations up to date");
} finally {
  await sql`select pg_advisory_unlock(7271)`;
  await sql.end();
}
