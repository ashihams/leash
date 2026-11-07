import { readFileSync } from "node:fs";
import { OfacScreenError, OfacSdnProvider } from "../server/src/providers/ofac.ts";

const saved = JSON.parse(readFileSync("keys/demo.json", "utf8")) as {
  vendors: Record<string, { publicKey: string }>;
};
const sanctions = new OfacSdnProvider();
await sanctions.ensureFresh();

for (const [name, key] of Object.entries(saved.vendors)) {
  try {
    const result = await sanctions.screenWallet(key.publicKey);
    const outcome = result.listed ? "fail LIST_MATCH_WALLET" : "pass";
    console.log(`${name} ${key.publicKey} ${outcome}`);
  } catch (error) {
    const code = error instanceof OfacScreenError ? error.code : "CHECK_UNAVAILABLE";
    console.log(`${name} ${key.publicKey} ${code}`);
  }
}
