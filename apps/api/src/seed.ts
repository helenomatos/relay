import { config } from "./config";
import { hashKey } from "./auth";
import { sql } from "./db";

/** Creates a demo tenant + endpoints so `docker compose up` is immediately usable. */
export async function seedDemo(log: (msg: string) => void) {
  const { apiKey, receiverSecret, endpoints } = config.demo;
  if (!apiKey || !receiverSecret) return;

  const hash = hashKey(apiKey);
  let [row] = await sql<{ tenantId: string }[]>`select tenant_id from api_keys where key_hash = ${hash}`;
  if (!row) {
    row = await sql.begin(async (tx) => {
      const [tenant] = await tx<{ id: string }[]>`insert into tenants (name) values ('Acme Inc') returning id`;
      await tx`insert into api_keys (tenant_id, key_hash, prefix) values (${tenant!.id}, ${hash}, ${apiKey.slice(0, 10)})`;
      return { tenantId: tenant!.id };
    });
    log(`seeded demo tenant ${row.tenantId}`);
  }

  const [existing] = await sql<{ count: number }[]>`
    select count(*)::int as count from endpoints where tenant_id = ${row.tenantId}`;
  if (existing!.count > 0 || !endpoints) return;

  for (const spec of endpoints.split(";").filter(Boolean)) {
    const [url, types = "*"] = spec.split("=");
    const eventTypes = types === "*" ? [] : types.split(",");
    await sql`
      insert into endpoints (tenant_id, url, secret, event_types)
      values (${row.tenantId}, ${url!}, ${receiverSecret}, ${eventTypes})`;
    log(`seeded endpoint ${url}`);
  }
}
