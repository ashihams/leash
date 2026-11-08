import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { parse } from "dotenv";

// Only app runtime configuration is copied; CLI tokens and database passwords
// never leave the local environment. Values are passed over stdin, not argv.
const project = JSON.parse(readFileSync(".vercel/project.json", "utf8"));
if (project.projectName !== "leash")
  throw new Error("Unexpected Vercel project");
const local = parse(readFileSync(".env"));
const names = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_KEY",
  "DIDIT_API_KEY",
  "DIDIT_WORKFLOW_ID",
  "DIDIT_WEBHOOK_SECRET",
  "DIDIT_ENVIRONMENT",
  "LEASH_USDC_MINT",
  "LEASH_POLICY_VERSION",
  "LLM_PROVIDER",
  "LLM_API_KEY",
  "LLM_MODEL",
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
];
const values = new Map(names.map((name) => [name, local[name]]));
values.set("VITE_GATE_URL", "/api/gate");
for (const [name, file] of [
  ["LEASH_POLICY_SECRET", "policy"],
  ["LEASH_VERIFIER_SECRET", "verifier"],
  ["LEASH_MINT_AUTHORITY", "mint-authority"],
]) {
  values.set(
    name,
    local[name] ||
      JSON.parse(readFileSync(`server/data/${file}.json`, "utf8")).secretKey
  );
}
for (const name of ["OFAC_SDN_SHA256"]) {
  if (local[name]) values.set(name, local[name]);
}
for (const [name, value] of values) {
  if (!value) throw new Error(`Missing local configuration: ${name}`);
}
const cli =
  process.env.VERCEL_CLI_PATH ||
  join(process.env.APPDATA, "npm/node_modules/vercel/dist/index.js");
for (const [name, value] of values) {
  const publicValue =
    name.startsWith("VITE_") ||
    [
      "SUPABASE_URL",
      "DIDIT_WORKFLOW_ID",
      "DIDIT_ENVIRONMENT",
      "LEASH_USDC_MINT",
      "LEASH_POLICY_VERSION",
    ].includes(name);
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        cli,
        "env",
        "add",
        name,
        "production",
        "--yes",
        publicValue ? "--no-sensitive" : "--sensitive",
      ],
      {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      }
    );
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `Vercel configuration failed for ${name} (exit ${code}); values were not logged.`
            )
          )
    );
    child.stdin.end(value);
  });
  console.log(`Configured ${name}`);
}
