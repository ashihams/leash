import "dotenv/config";
import { readFileSync } from "node:fs";
const ref = readFileSync("supabase/.temp/project-ref", "utf8").trim();
if (!/^[a-z0-9]{20}$/.test(ref))
  throw new Error("Invalid linked project reference");
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is missing");
const sql = readFileSync(
  "supabase/migrations/20261108080000_gate_provider_checks.sql",
  "utf8"
);
const response = await fetch(
  `https://api.supabase.com/v1/projects/${ref}/database/query`,
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: `begin;\n${sql}\ninsert into supabase_migrations.schema_migrations(version, name, statements) values ('20261108080000', 'gate_provider_checks', array[$leash_migration$${sql}$leash_migration$]) on conflict (version) do nothing;\ncommit;`,
    }),
    signal: AbortSignal.timeout(30000),
  }
);
if (!response.ok)
  throw new Error(`Provider migration failed: HTTP ${response.status}`);
console.log(
  "Provider evidence migration applied to the linked Supabase project."
);
