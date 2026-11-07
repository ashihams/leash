import { readFileSync } from "node:fs";
import {
  countByCurrency,
  downloadOfacSnapshot,
  parseOfacAdvancedXml,
} from "../server/src/providers/ofac.ts";

const file = process.argv[2];
const addresses = file
  ? await parseOfacAdvancedXml(readFileSync(file))
  : (await downloadOfacSnapshot()).addresses;
const counts = countByCurrency(addresses);
for (const symbol of Object.keys(counts).sort()) {
  console.log(`${symbol} ${counts[symbol]}`);
}
console.log(`SOL ${counts.SOL ?? 0}`);
console.log(`addresses ${addresses.length}`);
