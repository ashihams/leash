export const PHANTOM_NAME = "Phantom";
export const PHANTOM_INSTALL_URL = "https://phantom.com/";
export const SOLANA_FAUCET_URL = "https://faucet.solana.com";
export const DEVNET_CHAIN = "solana:devnet";
export const WALLET_PROMPT_MS = 60_000;

// Solana SDK ClusterType::Devnet in genesis_config.rs.
// Confirmed with getGenesisHash on https://api.devnet.solana.com.
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export const LOW_SOL_LAMPORTS = 50_000_000n;

export function isPhantomName(name: string) {
  return name === PHANTOM_NAME;
}

export function mandateOwnerKind(connectedAddress: string | undefined) {
  return connectedAddress ? "phantom" : "demo";
}

export function transactionsAllowed(genesis: string | null) {
  return genesis === DEVNET_GENESIS_HASH;
}

export function phantomOnDevnet(chains: readonly string[]) {
  return chains.includes(DEVNET_CHAIN);
}

export function transactionGuard(input: {
  genesis: string | null;
  chains: readonly string[];
  connected: boolean;
}): { ok: true } | { ok: false; reason: "rpc" | "chain" } {
  if (!transactionsAllowed(input.genesis)) return { ok: false, reason: "rpc" };
  if (input.connected && input.chains.length > 0 && !phantomOnDevnet(input.chains)) {
    return { ok: false, reason: "chain" };
  }
  return { ok: true };
}

export function withWalletTimeout<T>(work: Promise<T>, ms = WALLET_PROMPT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("The wallet prompt timed out."));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function describeWalletError(error: unknown) {
  const message = error instanceof Error ? error.message : "The wallet request failed.";
  if (/reject|rejected|4001|cancelled|canceled|user denied/i.test(message)) {
    return "Phantom closed the request. You can try again.";
  }
  if (/locked|unlock/i.test(message)) {
    return "Phantom is locked. Unlock it, then try again.";
  }
  if (/timed out|timeout|aborted/i.test(message)) {
    return "The wallet prompt timed out. You can try again.";
  }
  return message.split("\n")[0];
}

export function afterWalletPrompt(error?: unknown): { busy: false; message: string } {
  return { busy: false, message: error ? describeWalletError(error) : "" };
}

export function accountChangeNote(previous: string, next: string) {
  if (!next) return "Phantom disconnected. The demo owner key is the mandate owner again.";
  if (next !== previous) return "Phantom switched accounts. The new address is the mandate owner.";
  return "";
}
