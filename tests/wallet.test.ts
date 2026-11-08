import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { DEVNET_RPC, explorerTx } from "../src/leash/chain.ts";
import {
  DEVNET_CHAIN,
  DEVNET_GENESIS_HASH,
  PHANTOM_INSTALL_URL,
  WALLET_PROMPT_MS,
  accountChangeNote,
  afterWalletPrompt,
  describeWalletError,
  isPhantomName,
  mandateOwnerKind,
  transactionGuard,
  transactionsAllowed,
  withWalletTimeout,
} from "../src/leash/wallet.ts";

const SKIP = new Set(["node_modules", "dist", ".git", "target", ".anchor", "server/data", "api/generated"]);

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (path.replaceAll("\\", "/").endsWith("tests/wallet.test.ts")) continue;
    const info = statSync(path);
    if (info.isDirectory()) found.push(...sourceFiles(path));
    else if (/\.(ts|tsx|js|mjs|cjs|md|json|example|css|html)$/.test(entry)) found.push(path);
  }
  return found;
}

describe("wallet source", () => {
  it("has no MetaMask or Flask references in the source tree", () => {
    const hits = sourceFiles(process.cwd()).flatMap((path) => {
      const text = readFileSync(path, "utf8");
      return /metamask|@metamask|metamask-connect|\bFlask\b/i.test(text) ? [path] : [];
    });
    assert.deepEqual(hits, []);
  });
});

describe("Phantom fallback", () => {
  it("uses the demo owner key when Phantom is not connected", () => {
    assert.equal(mandateOwnerKind(undefined), "demo");
    assert.equal(isPhantomName("Phantom"), true);
    assert.equal(isPhantomName("MetaMask"), false);
    assert.equal(PHANTOM_INSTALL_URL, "https://phantom.com/");
  });
});

describe("wallet prompts", () => {
  it("recovers after a rejected prompt", () => {
    const result = afterWalletPrompt(new Error("User rejected the request"));
    assert.equal(result.busy, false);
    assert.match(result.message, /closed the request/);
    assert.match(describeWalletError(new Error("Wallet is locked")), /Unlock/);
  });

  it("times out a prompt that never returns", async () => {
    assert.equal(WALLET_PROMPT_MS, 60_000);
    await assert.rejects(
      withWalletTimeout(new Promise(() => undefined), 20),
      /timed out/,
    );
  });

  it("notices an account change and a disconnect", () => {
    assert.match(accountChangeNote("old", "new"), /switched accounts/);
    assert.match(accountChangeNote("old", ""), /disconnected/);
    assert.equal(accountChangeNote("same", "same"), "");
  });
});

describe("devnet guard", () => {
  it("blocks transactions when the genesis hash is not devnet", () => {
    assert.equal(transactionsAllowed(DEVNET_GENESIS_HASH), true);
    assert.equal(transactionsAllowed("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"), false);
    assert.deepEqual(
      transactionGuard({ genesis: "not-devnet", chains: [DEVNET_CHAIN], connected: true }),
      { ok: false, reason: "rpc" },
    );
    assert.deepEqual(
      transactionGuard({ genesis: DEVNET_GENESIS_HASH, chains: ["solana:mainnet"], connected: true }),
      { ok: false, reason: "chain" },
    );
    assert.deepEqual(
      transactionGuard({ genesis: DEVNET_GENESIS_HASH, chains: [], connected: false }),
      { ok: true },
    );
  });

  it("builds transactions only against the devnet connection", () => {
    assert.equal(DEVNET_RPC, "https://api.devnet.solana.com");
    assert.equal(explorerTx("sig").includes("cluster=devnet"), true);
    const chain = readFileSync(join(process.cwd(), "src/leash/chain.ts"), "utf8");
    const providers = readFileSync(join(process.cwd(), "src/providers.tsx"), "utf8");
    assert.equal(chain.includes("api.mainnet"), false);
    assert.equal(chain.includes("signAndSendTransaction"), false);
    assert.equal(providers.includes("api.mainnet"), false);
    assert.match(chain, /sendTransaction\(/);
  });
});
