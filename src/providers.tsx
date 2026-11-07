import { createSolanaClient } from "@metamask/connect-solana";
import {
  createClient,
  createWalletStandardConnector,
  watchWalletStandardConnectors,
  type WalletConnector,
} from "@solana/client";
import { SolanaProvider } from "@solana/react-hooks";
import { PropsWithChildren, useEffect, useState } from "react";

const ENDPOINT = "https://api.devnet.solana.com";

let metamaskConnectorPromise: Promise<WalletConnector | null> | undefined;
let republish: (() => void) | null = null;

function isMetaMask(connector: WalletConnector) {
  return (
    connector.id === "wallet-standard:metamask" ||
    connector.name.toLowerCase().includes("metamask")
  );
}

function loadMetaMaskConnector(): Promise<WalletConnector | null> {
  if (!metamaskConnectorPromise) {
    metamaskConnectorPromise = createSolanaClient({
      dapp: {
        name: "Leash",
        url: window.location.origin,
      },
      api: {
        supportedNetworks: {
          devnet: ENDPOINT,
          mainnet: "https://api.mainnet-beta.solana.com",
        },
      },
      analytics: { enabled: false },
    })
      .then((metamask) =>
        createWalletStandardConnector(metamask.getWallet(), {
          defaultChain: "solana:devnet",
          id: "wallet-standard:metamask",
          name: "MetaMask",
        }),
      )
      .catch((error: unknown) => {
        console.error(error);
        metamaskConnectorPromise = undefined;
        return null;
      });
  }
  return metamaskConnectorPromise;
}

function connectorList(
  sdk: WalletConnector | null,
  discovered: readonly WalletConnector[],
) {
  const extension = discovered.find(isMetaMask) ?? null;
  const rest = discovered.filter((connector) => !isMetaMask(connector));
  const metamask = extension ?? sdk;
  return metamask ? [metamask, ...rest] : [...rest];
}

export function refreshMetaMask() {
  metamaskConnectorPromise = undefined;
  republish?.();
}

export function Providers({ children }: PropsWithChildren) {
  const [client, setClient] = useState<ReturnType<typeof createClient> | null>(
    null,
  );

  useEffect(() => {
    try {
      window.localStorage.removeItem("solana:last-connector");
    } catch {
      // Connection still works if the browser blocks storage.
    }

    let discovered: readonly WalletConnector[] = [];
    let sdk: WalletConnector | null = null;
    let stopped = false;
    let sawMetaMask = false;
    let sdkRequest = 0;

    const publish = () => {
      if (stopped) return;
      const connectors = connectorList(sdk, discovered);
      const hasMetaMask = connectors.some(isMetaMask);
      setClient((current) => {
        if (current && sawMetaMask) return current;
        if (current && !hasMetaMask) return current;
        if (hasMetaMask) sawMetaMask = true;
        current?.destroy();
        return createClient({
          endpoint: ENDPOINT,
          walletConnectors: connectors,
        });
      });
    };

    const stop = watchWalletStandardConnectors((next) => {
      discovered = next;
      publish();
    });

    const finishSdk = () => {
      const request = ++sdkRequest;
      loadMetaMaskConnector().then((connector) => {
        if (stopped || request !== sdkRequest) return;
        sdk = connector;
        publish();
      });
    };

    republish = finishSdk;
    finishSdk();

    return () => {
      stopped = true;
      if (republish === finishSdk) republish = null;
      stop();
    };
  }, []);

  if (!client) return null;

  return (
    <SolanaProvider client={client} walletPersistence={false}>
      {children}
    </SolanaProvider>
  );
}
