import { createHash } from "node:crypto";
import {
  address,
  createSolanaRpc,
  getProgramDerivedAddress,
} from "@solana/kit";
import { encodeBase58 } from "./bytes.ts";
import { CROSS_BORDER_ROUTES, countrySeed } from "../../src/leash/corridors.ts";
import {
  DEVNET_RPC,
  PROGRAM_ID,
  PROGRAM_LOADER,
} from "../../src/leash/deployment.ts";
import { DEVNET_GENESIS_HASH } from "../../src/leash/wallet.ts";

type Account = {
  owner: string;
  executable: boolean;
  data: readonly [string, string];
} | null;
export type ChainSnapshot = {
  cluster: "devnet";
  rpc: string;
  program: string;
  programDeployed: boolean;
  configAddress: string;
  config: null | {
    admin: string;
    mint: string;
    policySigner: string;
    verifier: string;
    policyVersion: number;
    requiredChecks: number;
  };
  routes: Array<{
    id: string;
    address: string;
    status: "missing" | "invalid" | "disabled" | "ready";
    perPaymentCap?: string;
    dailyCap?: string;
    packetThreshold?: string;
  }>;
};

export function checkedAccount(account: Account, name: string, size: number) {
  if (!account || account.owner !== PROGRAM_ID || account.executable)
    return null;
  const data = Buffer.from(account.data[0], "base64");
  const discriminator = createHash("sha256")
    .update(`account:${name}`)
    .digest()
    .subarray(0, 8);
  return data.length === size && data.subarray(0, 8).equals(discriminator)
    ? data
    : null;
}

export async function readChainSnapshot(): Promise<ChainSnapshot> {
  const rpc = createSolanaRpc(DEVNET_RPC);
  const program = address(PROGRAM_ID);
  const [configAddress] = await getProgramDerivedAddress({
    programAddress: program,
    seeds: [new TextEncoder().encode("config")],
  });
  const routeAddresses = await Promise.all(
    CROSS_BORDER_ROUTES.map(async (route) => {
      const [pda] = await getProgramDerivedAddress({
        programAddress: program,
        seeds: [
          new TextEncoder().encode("corridor"),
          countrySeed(route.fromCountry),
          countrySeed(route.toCountry),
        ],
      });
      return pda;
    })
  );
  const signal = AbortSignal.timeout(8000);
  const [genesis, accounts] = await Promise.all([
    rpc.getGenesisHash().send({ abortSignal: signal }),
    rpc
      .getMultipleAccounts([program, configAddress, ...routeAddresses], {
        encoding: "base64",
        commitment: "confirmed",
      })
      .send({ abortSignal: signal }),
  ]);
  if (genesis !== DEVNET_GENESIS_HASH) throw new Error("RPC_NOT_DEVNET");
  const [executable, settings, ...routes] = accounts.value;
  const data = checkedAccount(settings, "Config", 149);
  return {
    cluster: "devnet",
    rpc: DEVNET_RPC,
    program: PROGRAM_ID,
    programDeployed:
      executable?.executable === true && executable.owner === PROGRAM_LOADER,
    configAddress,
    config: data
      ? {
          admin: encodeBase58(data.subarray(8, 40)),
          policySigner: encodeBase58(data.subarray(40, 72)),
          verifier: encodeBase58(data.subarray(72, 104)),
          mint: encodeBase58(data.subarray(104, 136)),
          policyVersion: Number(data.readBigUInt64LE(136)),
          requiredChecks: data.readUInt32LE(144),
        }
      : null,
    routes: CROSS_BORDER_ROUTES.map((route, index) => {
      const account = routes[index];
      const bytes = checkedAccount(account, "Corridor", 54);
      const valid =
        bytes &&
        bytes.subarray(8, 12).toString("ascii") ===
          `${route.fromCountry}${route.toCountry}` &&
        bytes[12] <= 1;
      return {
        id: route.id,
        address: routeAddresses[index],
        status: !account
          ? "missing"
          : !valid
            ? "invalid"
            : bytes[12] === 1
              ? "ready"
              : "disabled",
        ...(valid
          ? {
              perPaymentCap: bytes.readBigUInt64LE(13).toString(),
              dailyCap: bytes.readBigUInt64LE(21).toString(),
              packetThreshold: bytes.readBigUInt64LE(45).toString(),
            }
          : {}),
      };
    }),
  };
}
