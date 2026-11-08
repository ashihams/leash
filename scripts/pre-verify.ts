import { readFileSync } from "node:fs";
import { assertProviderConfig } from "../server/src/providers/config.ts";
import { DiditIdentity } from "../server/src/providers/identity.ts";

const config = assertProviderConfig(process.env);
const saved = JSON.parse(readFileSync("keys/demo.json", "utf8")) as {
  vendors: Record<string, { publicKey: string }>;
};
const identity = new DiditIdentity(
  config.diditKey,
  config.diditWorkflowId,
  config.diditWebhookSecret
);

for (const [name, key] of Object.entries(saved.vendors)) {
  const session = await identity.createSession(key.publicKey);
  console.log(`${name} ${key.publicKey}`);
  console.log(session.url);
}
