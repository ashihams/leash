import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import {
  createSupabaseOfacStore,
  downloadOfacSnapshot,
  OfacSdnProvider,
} from "../server/src/providers/ofac.ts";

const snapshot = await downloadOfacSnapshot({
  expectedSha256: process.env.OFAC_SDN_SHA256 || null,
});
const provider = new OfacSdnProvider();
provider.load(snapshot);
provider.remember();
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  const client = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );
  await createSupabaseOfacStore(client).save(snapshot);
  console.log(
    "Stored the OFAC SDN address index. The latest 3 versions are kept."
  );
} else {
  console.log("Supabase is not configured. The index was saved locally only.");
}
for (const symbol of Object.keys(snapshot.counts).sort()) {
  console.log(`${symbol} ${snapshot.counts[symbol]}`);
}
console.log(`addresses ${snapshot.addressCount}`);
console.log(`SOL ${snapshot.solAddressCount}`);
console.log(`sha256 ${snapshot.sha256}`);
console.log(`retrieved ${snapshot.retrievedAt.slice(0, 10)}`);
