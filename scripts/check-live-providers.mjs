import "dotenv/config";
import { assertProviderConfig } from "../server/src/providers/config.ts";
import { DiditIdentity } from "../server/src/providers/identity.ts";
import { OfacSdnProvider } from "../server/src/providers/ofac.ts";

const config = assertProviderConfig(process.env);
const identity = new DiditIdentity(
  config.diditKey,
  config.diditWorkflowId,
  config.diditWebhookSecret
);
await identity.ping();
console.log("Didit authenticated decision endpoint: reachable");
const response = await fetch("https://verification.didit.me/v3/workflows/", {
  headers: { "x-api-key": config.diditKey },
  signal: AbortSignal.timeout(15000),
});
if (!response.ok)
  throw new Error(`Didit workflow lookup failed: HTTP ${response.status}`);
const body = await response.json();
const workflows = Array.isArray(body) ? body : (body.results ?? []);
if (!workflows.some((row) => row.workflow_id === config.diditWorkflowId))
  throw new Error("Configured Didit workflow was not found");
console.log("Configured Didit workflow: found");
const ofac = new OfacSdnProvider();
await ofac.ensureFresh({ expectedSha256: process.env.OFAC_SDN_SHA256 ?? null });
if (!(await ofac.health()))
  throw new Error("OFAC list is unavailable or stale");
const screened = await ofac.screenWallet("11111111111111111111111111111111");
console.log(
  JSON.stringify({
    ofac: "ready",
    controlWalletListed: screened.listed,
    note: screened.raw.statement,
  })
);
