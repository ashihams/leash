import { watchWalletStandardConnectors, createClient, type WalletConnector } from "@solana/client";
import { SolanaProvider } from "@solana/react-hooks";
import { PropsWithChildren, useEffect, useState, useSyncExternalStore } from "react";
import { DEVNET_CHAIN, isPhantomName } from "./leash/wallet";

const ENDPOINT = "https://api.devnet.solana.com";

type PhantomWallet = {
  accounts: readonly { chains: readonly string[] }[];
  features?: {
    "standard:events"?: {
      on: (event: "change", listener: () => void) => void;
    };
  };
};

const watched = new WeakSet<object>();
let phantomWallet: PhantomWallet | null = null;
let phantomChains: string[] = [];
const listeners = new Set<() => void>();

function publishChains(chains: readonly string[]) {
  phantomChains = [...chains];
  listeners.forEach((listener) => listener());
}

export function refreshPhantomChains() {
  if (phantomWallet) rememberPhantom(phantomWallet);
}

function rememberPhantom(wallet: PhantomWallet) {
  phantomWallet = wallet;
  const account = wallet.accounts.find((item) => item.chains.includes(DEVNET_CHAIN)) ?? wallet.accounts[0];
  publishChains(account?.chains ?? []);
  const events = wallet.features?.["standard:events"];
  if (events && !watched.has(wallet)) {
    watched.add(wallet);
    events.on("change", () => rememberPhantom(wallet));
  }
}

export function phantomChainsSnapshot() {
  return phantomChains;
}

export function usePhantomChains() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    phantomChainsSnapshot,
    () => [],
  );
}

export function Providers({ children }: PropsWithChildren) {
  const [client, setClient] = useState(() =>
    createClient({ endpoint: ENDPOINT, walletConnectors: [] }),
  );

  useEffect(() => {
    let stopped = false;
    const stop = watchWalletStandardConnectors(
      (found) => {
        if (stopped) return;
        const phantomOnly = found.filter((connector: WalletConnector) => isPhantomName(connector.name));
        setClient((current) => {
          current?.destroy();
          return createClient({
            endpoint: ENDPOINT,
            walletConnectors: phantomOnly,
          });
        });
      },
      {
        overrides: (wallet) => {
          if (!isPhantomName(wallet.name)) return undefined;
          rememberPhantom(wallet as PhantomWallet);
          return { defaultChain: DEVNET_CHAIN, id: "wallet-standard:phantom" };
        },
      },
    );
    return () => {
      stopped = true;
      stop();
    };
  }, []);

  return (
    <SolanaProvider client={client} walletPersistence={false}>
      {children}
    </SolanaProvider>
  );
}
