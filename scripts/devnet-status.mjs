import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { address, createSolanaRpc, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";

const program = address("8Eq2Ug3URR5ugzDfjYk4bbkBJa8o7U6YZtPp6vLDHezd");
const loader = address("BPFLoaderUpgradeab1e11111111111111111111111");
const rpc = createSolanaRpc("https://api.devnet.solana.com");
const [config] = await getProgramDerivedAddress({ programAddress: program, seeds: [new TextEncoder().encode("config")] });
const [corridor] = await getProgramDerivedAddress({ programAddress: program, seeds: [new TextEncoder().encode("corridor"), new Uint8Array([85, 83]), new Uint8Array([85, 83])] });
const [programData] = await getProgramDerivedAddress({ programAddress: loader, seeds: [getAddressEncoder().encode(program)] });
const genesis = await rpc.getGenesisHash().send();
if (genesis !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") throw new Error("RPC is not devnet");
const { value: [executable, deployed, settings, route] } = await rpc.getMultipleAccounts([program, programData, config, corridor], { encoding: "base64", commitment: "confirmed" }).send();
if (!executable?.executable || executable.owner !== loader) throw new Error("Program is not deployed");
if (!deployed || deployed.owner !== loader) throw new Error("Invalid program data account");
const elf = readFileSync("anchor/target/deploy/leash.so");
const deployedBytes = Buffer.from(deployed.data[0], "base64");
if (!deployedBytes.subarray(45, 45 + elf.length).equals(elf)) throw new Error("Deployed program differs from local binary");
function checkedData(account, name, size) {
  if (!account || account.owner !== program) throw new Error(`Invalid ${name} owner`);
  const data = Buffer.from(account.data[0], "base64");
  const discriminator = createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
  if (data.length !== size || !data.subarray(0, 8).equals(discriminator)) throw new Error(`Invalid ${name} data`);
  return data;
}
const data = checkedData(settings, "Config", 149);
const corridorData = checkedData(route, "Corridor", 54);
const mint = bs58.encode(data.subarray(104, 136));
const status = {
  cluster: "devnet", program, executable: true, binaryMatches: true,
  config, corridor, corridorEnabled: corridorData[12] === 1,
  admin: bs58.encode(data.subarray(8, 40)),
  policySigner: bs58.encode(data.subarray(40, 72)),
  verifier: bs58.encode(data.subarray(72, 104)), mint,
  policyVersion: Number(data.readBigUInt64LE(136)), requiredChecks: data.readUInt32LE(144),
  environmentMintMatches: process.env.LEASH_USDC_MINT === mint,
};
try {
  const health = await (await fetch("http://127.0.0.1:8787/health")).json();
  status.gateMatches = health.mint === mint && health.policySigner === status.policySigner && health.verifier === status.verifier && health.policyVersion === status.policyVersion;
} catch { status.gateMatches = false; }
console.log(JSON.stringify(status, null, 2));
if (!status.corridorEnabled || !status.environmentMintMatches || !status.gateMatches) process.exitCode = 1;
