import "dotenv/config";
import { readFileSync } from "node:fs";

const ref = readFileSync("supabase/.temp/project-ref", "utf8").trim();
if (!/^[a-z0-9]{20}$/.test(ref))
  throw new Error("Invalid linked project reference");
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is missing");
async function query(sql) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/database/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!response.ok)
    throw new Error(`Agent migration failed: HTTP ${response.status}`);
  return response.json();
}
const version = "20261108180000";
const existing = await query(
  `select version from supabase_migrations.schema_migrations where version = '${version}'`
);
if (existing.length) {
  console.log("Agent migration already applied.");
} else {
  const sql = readFileSync(
    `supabase/migrations/${version}_agent_runs.sql`,
    "utf8"
  );
  await query(
    `begin;\n${sql}\ninsert into supabase_migrations.schema_migrations(version, name, statements) values ('${version}', 'agent_runs', array[$agent_migration$${sql}$agent_migration$]);\ncommit;`
  );
  console.log(
    "Agent runs table created with RLS and service-role-only access."
  );
}
const [check] = await query(
  "select c.relrowsecurity as rls, has_table_privilege('anon', 'public.agent_runs', 'SELECT') as anon_read, has_table_privilege('authenticated', 'public.agent_runs', 'INSERT') as authenticated_write from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='agent_runs'"
);
if (!check?.rls || check.anon_read || check.authenticated_write)
  throw new Error("Agent table access check failed");
console.log("Agent table access checks passed.");
