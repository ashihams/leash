import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import nacl from "tweetnacl";
import { AccountAccess } from "./AccountAccess";
import { refreshMetaMask } from "./providers";
import { Arrow, SiteHeader } from "./ui";
import {
  base64ToBytes,
  baseToUsdc,
  bytesToBase64,
  gate,
  pubkey,
  randomHex,
  sha256Hex,
  signIntent,
  usdcToBase,
  type GateResult,
} from "./leash/client";
import { decodeBase58 } from "../server/src/bytes.ts";
import { mandatePda } from "./leash/pda";

type Vendor = {
  name: string;
  country: string;
  blocked: boolean;
  note: string;
  publicKey: Uint8Array;
  address: string;
};

type LogLine = { title: string; detail: string };

const BUDGET = 200;
const PER_PAYMENT = 150;

function walletErrorText(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : error
        ? "The wallet refused the connection."
        : "";
  if (!message) return "";
  if (
    message.includes("already pending") ||
    message.includes("wallet_requestPermissions")
  ) {
    return "MetaMask already has a request open. Click the MetaMask icon in the toolbar and approve or reject it. Then click Connect MetaMask once.";
  }
  if (
    message.includes("reading 'create'") ||
    message.includes("No wallet connector")
  ) {
    return "MetaMask did not open. Unlock the MetaMask extension, turn on a Solana account, and try again.";
  }
  if (message.toLowerCase().includes("no accounts")) {
    return "MetaMask returned no Solana account. Create or unlock a Solana account in MetaMask, then try again.";
  }
  return message;
}

export function Dashboard() {
  const { connectors, connect, disconnect, error, wallet, status } =
    useWalletConnection();
  const demoOwner = useMemo(() => nacl.sign.keyPair(), []);
  const agent = useMemo(() => nacl.sign.keyPair(), []);
  const vendors = useMemo<Vendor[]>(
    () =>
      [
        {
          name: "North Studio",
          country: "US",
          blocked: false,
          note: "Demo studio. A registered payout wallet.",
          publicKey: nacl.sign.keyPair().publicKey,
        },
        {
          name: "Grey Market",
          country: "US",
          blocked: true,
          note: "On the local block list. The gate should refuse.",
          publicKey: nacl.sign.keyPair().publicKey,
        },
      ].map((vendor) => ({ ...vendor, address: pubkey(vendor.publicKey) })),
    []
  );

  const [gateState, setGateState] = useState("The gate has not been checked.");
  const [mandateId, setMandateId] = useState(7);
  const [mandateAccount, setMandateAccount] = useState("");
  const [vendorName, setVendorName] = useState(vendors[0].name);
  const [amount, setAmount] = useState("100");
  const [goal, setGoal] = useState("Buy a logo from a studio for 100 USDC.");
  const [busy, setBusy] = useState(false);
  const [walletNote, setWalletNote] = useState("");
  const connectLock = useRef(false);
  const actionLock = useRef(false);
  const session = useRef({
    mandateId: 7,
    mandateAccount: "",
    mandateOwner: "",
    mint: "",
    corridorSet: false,
  });
  const [log, setLog] = useState<LogLine[]>([]);
  const [lastPayment, setLastPayment] = useState("");
  const [funded, setFunded] = useState<{
    invoiceHash: string;
    amount: number;
    vendor: string;
  } | null>(null);
  const [lastClearance, setLastClearance] = useState<{
    message: string;
    signature: string;
    signer: string;
  } | null>(null);

  const connected = wallet?.account.address?.toString();
  const ownerAddress = connected ?? pubkey(demoOwner.publicKey);
  const agentAddress = pubkey(agent.publicKey);
  const vendor = vendors.find((item) => item.name === vendorName) ?? vendors[0];

  function push(title: string, detail: string) {
    setLog((current) => [{ title, detail }, ...current].slice(0, 12));
  }

  function run(work: () => Promise<unknown>) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    work().finally(() => {
      actionLock.current = false;
      setBusy(false);
    });
  }

  const readGate = useCallback(async (): Promise<string> => {
    const result = await gate("/health");
    if (result.status !== 200) {
      setGateState("The gate answered, but not with a health record.");
      return "";
    }
    const reportedMint = String(result.body.mint ?? "");
    session.current.mint = reportedMint;
    setGateState(
      `Gate is up. Policy signer ${String(result.body.policySigner ?? "")}.`
    );
    return reportedMint;
  }, []);

  useEffect(() => {
    let cancelled = false;
    readGate().catch(() => {
      if (!cancelled) {
        setGateState("The gate is not running. Start it with npm run server.");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [readGate]);

  useEffect(() => {
    if (
      connectors.some((connector) =>
        connector.name.toLowerCase().includes("metamask"),
      )
    ) {
      setWalletNote((note) =>
        note.startsWith("Looking for MetaMask") ? "" : note,
      );
    }
  }, [connectors]);

  async function checkGate() {
    try {
      await readGate();
    } catch {
      setGateState("The gate is not running. Start it with npm run server.");
    }
  }

  async function loadMint() {
    if (session.current.mint) return session.current.mint;
    try {
      return await readGate();
    } catch {
      setGateState("The gate is not running. Start it with npm run server.");
      push("Gate", "The gate is not running on this machine.");
      return "";
    }
  }

  async function registerVendors() {
    for (const item of vendors) {
      const registered = await gate("/vendors", {
        wallet: item.address,
        name: item.name,
        country: item.country,
        blocked: item.blocked,
      });
      if (registered.status >= 400) {
        push(item.name, errorText(registered));
        return false;
      }
    }
    return true;
  }

  async function writeCorridor(enabled: boolean) {
    const result = await gate("/corridors", {
      fromCountry: "US",
      toCountry: "US",
      enabled,
      perPaymentCap: usdcToBase(PER_PAYMENT),
      dailyCap: usdcToBase(1000),
      packetThreshold: 0,
    });
    if (result.status >= 400) {
      push("Corridor", errorText(result));
      return false;
    }
    session.current.corridorSet = true;
    return true;
  }

  async function ensureMandate(startId: number, reopenCorridor: boolean) {
    const activeMint = await loadMint();
    if (!activeMint) {
      push("Gate", "The gate did not report the test mint.");
      return null;
    }
    if (!(await registerVendors())) return null;
    if (reopenCorridor || !session.current.corridorSet) {
      if (!(await writeCorridor(true))) return null;
    }
    const who =
      ownerAddress === connected ? "the connected wallet" : "the demo owner key";
    if (
      session.current.mandateAccount &&
      session.current.mandateOwner === ownerAddress &&
      (startId === session.current.mandateId || !reopenCorridor)
    ) {
      if (reopenCorridor) {
        push(
          "Mandate open",
          `Mandate ${session.current.mandateId} is already open for ${who}. Budget ${BUDGET}.00 USDC.`
        );
      }
      return {
        id: session.current.mandateId,
        account: session.current.mandateAccount,
        owner: ownerAddress,
        mint: activeMint,
      };
    }
    const now = Math.floor(Date.now() / 1000);
    const skipped: number[] = [];
    let id = startId;
    try {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const mandate = String(await mandatePda(ownerAddress, id));
        const created = await gate("/mandates", {
          mandateId: id,
          mandate,
          owner: ownerAddress,
          agent: agentAddress,
          budget: usdcToBase(BUDGET),
          perPaymentLimit: usdcToBase(PER_PAYMENT),
          maxUses: 4,
          expiresAt: now + 86_400 * 10,
          deliverySeconds: 3600,
          acceptanceSeconds: 3600,
          category: 7,
          corridors: [{ fromCountry: "US", toCountry: "US" }],
        });
        if (
          created.status === 409 &&
          errorText(created).includes("MANDATE_EXISTS")
        ) {
          skipped.push(id);
          id += 1;
          continue;
        }
        if (created.status >= 400) {
          push("Mandate", errorText(created));
          return null;
        }
        session.current.mandateId = id;
        session.current.mandateAccount = mandate;
        session.current.mandateOwner = ownerAddress;
        setMandateId(id);
        setMandateAccount(mandate);
        push(
          "Mandate open",
          skipped.length > 0
            ? `${skipped.length === 1 ? `Mandate ${skipped[0]} was` : `Mandates ${skipped.join(", ")} were`} already stored. Mandate ${id} is open for ${who}. Budget ${BUDGET}.00 USDC.`
            : `Mandate ${id} for ${who}. Budget ${BUDGET}.00 USDC.`
        );
        return { id, account: mandate, owner: ownerAddress, mint: activeMint };
      }
    } catch (error) {
      push(
        "Mandate",
        error instanceof Error ? error.message : "Could not open the mandate."
      );
      return null;
    }
    push("Mandate", "The gate already has every mandate id this page tried.");
    return null;
  }

  function openMandate(nextId = session.current.mandateId) {
    return ensureMandate(nextId, true);
  }

  async function ask(next?: {
    vendor?: string;
    usdc?: string;
    dispute?: boolean;
  }) {
    const chosen =
      vendors.find((item) => item.name === (next?.vendor ?? vendorName)) ??
      vendor;
    const usdc = Number(next?.usdc ?? amount);
    if (!Number.isFinite(usdc) || usdc <= 0) {
      push("Amount", "Enter a USDC amount greater than zero.");
      return null;
    }
    const ready = await ensureMandate(session.current.mandateId, false);
    if (!ready) return null;
    try {
      const paymentId = randomHex();
      const invoiceHash = randomHex();
      const base = usdcToBase(usdc);
      const fields = {
        paymentId,
        mandateId: ready.id,
        mandate: ready.account,
        buyer: ready.owner,
        vendor: chosen.address,
        mint: ready.mint,
        amount: base,
        fromCountry: "US",
        toCountry: "US",
        category: 7,
        purposeCode: 1001,
        invoiceHash,
        invoiceAmount: base,
        invoiceCurrency: "USD",
        intentSignature: signIntent(agent.secretKey, {
          kind: 1,
          paymentId,
          mandate: ready.account,
          buyer: ready.owner,
          vendor: chosen.address,
          mint: ready.mint,
          amount: base,
          invoiceHash,
        }),
      };
      const result = await gate("/clearances/fund", fields);
      const clearance =
        result.body.decision === "allow" &&
        typeof result.body.message === "string" &&
        typeof result.body.signature === "string"
          ? {
              message: result.body.message,
              signature: result.body.signature,
              signer: String(result.body.signer ?? ""),
            }
          : null;
      if (result.body.decision === "allow") {
        setLastPayment(paymentId);
        setFunded({ invoiceHash, amount: base, vendor: chosen.address });
        if (clearance) setLastClearance(clearance);
      }
      const reasons = reasonsOf(result);
      push(
        `${chosen.name} · ${result.body.decision === "allow" ? "Allow" : "Deny"}`,
        reasons.length > 0 ? reasons.join(", ") : "The gate signed an allow."
      );
      if (reasons.includes("VENDOR_BLOCKED")) {
        setVendorName("North Studio");
        push(
          "Adapt",
          "Grey Market is blocked. The next request uses North Studio."
        );
      } else if (
        reasons.includes("PAYMENT_LIMIT") ||
        reasons.includes("BUDGET")
      ) {
        setAmount("100");
        push(
          "Adapt",
          "That amount is outside the leash. The field is back to 100 USDC."
        );
      } else if (reasons.includes("CORRIDOR_BLOCKED")) {
        push("Adapt", "The corridor is closed. Reopen it, or stop.");
      } else if (reasons.includes("MANDATE_REVOKED")) {
        push(
          "Adapt",
          "This mandate is revoked. Open a new one for the next payment."
        );
      }
      return {
        decision: String(result.body.decision ?? "deny"),
        paymentId,
        invoiceHash,
        amount: base,
        vendor: chosen.address,
        clearance,
      };
    } catch (error) {
      push(
        "Clearance",
        error instanceof Error ? error.message : "The request failed."
      );
      return null;
    }
  }

  function remember(result: GateResult) {
    if (
      typeof result.body.message === "string" &&
      typeof result.body.signature === "string"
    ) {
      setLastClearance({
        message: result.body.message,
        signature: result.body.signature,
        signer: String(result.body.signer ?? ""),
      });
    }
  }

  async function deliverAndRelease() {
    let paymentId = lastPayment;
    let payment = funded;
    let account = session.current.mandateAccount;
    let buyer = session.current.mandateOwner;
    let activeMint = session.current.mint;
    if (!paymentId || !payment || !account) {
      const fundedPayment = await ask();
      if (!fundedPayment || fundedPayment.decision !== "allow") {
        push(
          "Release",
          "The gate did not allow a payment, so there is nothing to release."
        );
        return;
      }
      paymentId = fundedPayment.paymentId;
      payment = {
        invoiceHash: fundedPayment.invoiceHash,
        amount: fundedPayment.amount,
        vendor: fundedPayment.vendor,
      };
      account = session.current.mandateAccount;
      buyer = session.current.mandateOwner;
      activeMint = session.current.mint;
    }
    try {
      const artifact = new TextEncoder().encode(`DLV1${goal}`.slice(0, 256));
      const receiptHash = await sha256Hex(artifact);
      const delivered = await gate("/payments/delivery", {
        paymentId,
        receiptHash,
      });
      if (delivered.status >= 400) {
        push("Delivery", errorText(delivered));
        return;
      }
      const verified = await gate("/payments/verify", {
        paymentId,
        artifact: bytesToBase64(artifact),
      });
      if (verified.status >= 400) {
        push("Verifier", errorText(verified));
        return;
      }
      const release = await gate("/clearances/release", {
        paymentId,
        intentSignature: signIntent(agent.secretKey, {
          kind: 2,
          paymentId,
          mandate: account,
          buyer,
          vendor: payment.vendor,
          mint: activeMint,
          amount: payment.amount,
          invoiceHash: payment.invoiceHash,
        }),
      });
      push(
        release.body.decision === "allow" ? "Release allow" : "Release refused",
        reasonsOf(release).join(", ") || "The gate signed the release."
      );
    } catch (error) {
      push(
        "Release",
        error instanceof Error ? error.message : "Release failed."
      );
    }
  }

  async function swapVendor() {
    const clearance =
      lastClearance ?? (await ask())?.clearance ?? null;
    if (!clearance) {
      push("Swap", "The gate did not sign a clearance, so there is nothing to swap.");
      return;
    }
    const message = base64ToBytes(clearance.message);
    const signature = base64ToBytes(clearance.signature);
    const signer = decodeBase58(clearance.signer);
    const swapped = message.slice();
    const other =
      vendors.find((item) => item.address !== vendor.address) ?? vendors[1];
    swapped.set(other.publicKey, 100);
    const originalOk = nacl.sign.detached.verify(message, signature, signer);
    const swappedOk = nacl.sign.detached.verify(swapped, signature, signer);
    push(
      "Swapped vendor",
      `Original signature ${originalOk ? "verifies" : "does not verify"}. After the vendor bytes change, the same signature ${swappedOk ? "still verifies" : "does not verify"}. The program rejects that clearance.`
    );
  }

  async function disableCorridor() {
    if (!(await writeCorridor(false))) return;
    push(
      "Corridor disabled",
      "The honest gate should now refuse the next funding."
    );
    await ask();
  }

  async function forceAllow() {
    const ready = await ensureMandate(session.current.mandateId, false);
    if (!ready) return;
    try {
      const paymentId = randomHex();
      const invoiceHash = randomHex();
      const base = usdcToBase(Number(amount) || 100);
      const result = await gate("/demo/force-clearance", {
        kind: "fund",
        decision: "allow",
        paymentId,
        mandateId: ready.id,
        mandate: ready.account,
        buyer: ready.owner,
        vendor: vendor.address,
        mint: ready.mint,
        amount: base,
        fromCountry: "US",
        toCountry: "US",
        category: 7,
        purposeCode: 1001,
        invoiceHash,
        invoiceAmount: base,
        invoiceCurrency: "USD",
      });
      if (result.status >= 400) {
        push("Force", errorText(result));
        return;
      }
      remember(result);
      push(
        "Forced allow",
        "The compromised signer path returned a signed allow. The program still enforces the corridor and the mandate."
      );
    } catch (error) {
      push("Force", error instanceof Error ? error.message : "Force failed.");
    }
  }

  async function revoke() {
    const ready = await ensureMandate(session.current.mandateId, false);
    if (!ready) return;
    const result = await gate("/mandates/revoke", { mandateId: ready.id });
    if (result.status >= 400) {
      push("Revoke", errorText(result));
      return;
    }
    push(
      "Mandate revoked",
      "The next honest funding should fail even if a signer is later forced."
    );
    await ask();
  }

  return (
    <div className="k-page">
      <SiteHeader route="dashboard" />
      <main id="content" className="k-dashboard">
        <header className="k-dash-title">
          <p className="k-index">Devnet · local gate</p>
          <h1>The leash</h1>
          <p>
            This page drives the compliance gate. It does not submit a Solana
            transaction. Connect a wallet when you want the mandate owner to be
            that address. Otherwise the demo owner key is used, and it is not
            your wallet.
          </p>
        </header>

        <section className="k-block" aria-labelledby="wallet-title">
          <h2 id="wallet-title">Wallet</h2>
          <p className="k-status" role="status">
            {status === "connected"
              ? "Connected"
              : status === "connecting"
                ? "Waiting for MetaMask"
                : "Not connected"}
          </p>
          {status === "connecting" ? (
            <p role="status">
              Click the MetaMask icon and approve the open request. Leave that
              window open until it finishes.
            </p>
          ) : null}
          {walletNote || walletErrorText(error) ? (
            <p role="status">{walletNote || walletErrorText(error)}</p>
          ) : null}
          <div className="k-connectors">
            {connectors.map((connector) => (
              <button
                key={connector.id}
                type="button"
                className="k-action k-action-ghost"
                onClick={() => {
                  if (connectLock.current || status === "connecting") return;
                  connectLock.current = true;
                  setWalletNote("");
                  connect(connector.id)
                    .catch((caught: unknown) => {
                      setWalletNote(
                        walletErrorText(caught) ||
                          "The wallet refused the connection.",
                      );
                    })
                    .finally(() => {
                      connectLock.current = false;
                    });
                }}
                disabled={status === "connecting" || connectLock.current}
              >
                {connector.name.toLowerCase().includes("metamask")
                  ? "Connect MetaMask"
                  : connector.name}
                <Arrow />
              </button>
            ))}
            {connectors.some((connector) =>
              connector.name.toLowerCase().includes("metamask"),
            ) ? null : (
              <button
                type="button"
                className="k-action k-action-ghost"
                onClick={() => {
                  setWalletNote(
                    "Looking for MetaMask. Unlock the extension, then click Connect MetaMask again.",
                  );
                  refreshMetaMask();
                }}
                disabled={status === "connecting"}
              >
                Connect MetaMask
                <Arrow />
              </button>
            )}
          </div>
          <p className="k-mono">
            {connected ?? "No wallet connected. The demo owner key is ready."}
          </p>
          <button
            type="button"
            className="k-action k-action-ghost"
            onClick={() => {
              if (status !== "connected") {
                push(
                  "Wallet",
                  "No wallet is connected. Connect MetaMask, or keep the demo owner key."
                );
                return;
              }
              disconnect();
              push("Wallet", "Disconnected. The demo owner key is the mandate owner again.");
            }}
          >
            Disconnect
            <Arrow direction="left" />
          </button>
        </section>

        <AccountAccess wallet={wallet} />

        <section className="k-block" aria-labelledby="gate-title">
          <h2 id="gate-title">Gate</h2>
          <p role="status">{gateState}</p>
          <p className="k-mono">Agent key {agentAddress}</p>
          <div className="k-actions">
            <button
              type="button"
              className="k-action"
              onClick={() => run(checkGate)}
              disabled={busy}
            >
              Check the gate
              <Arrow />
            </button>
            <button
              type="button"
              className="k-action"
              onClick={() => run(() => openMandate())}
              disabled={busy}
            >
              Open a mandate
              <Arrow />
            </button>
          </div>
          {mandateAccount ? (
            <p className="k-mono">
              Mandate {mandateId} · {mandateAccount}
            </p>
          ) : null}
        </section>

        <section className="k-block" aria-labelledby="proposal-title">
          <h2 id="proposal-title">Proposal</h2>
          <form
            className="k-form"
            onSubmit={(event) => {
              event.preventDefault();
              run(() => ask().then(() => undefined));
            }}
          >
            <label>
              Goal
              <textarea
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                rows={3}
              />
            </label>
            <label>
              Amount in test USDC
              <input
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
            <fieldset>
              <legend>Vendor</legend>
              {vendors.map((item) => (
                <label className="k-choice" key={item.address}>
                  <input
                    type="radio"
                    name="vendor"
                    value={item.name}
                    checked={vendorName === item.name}
                    onChange={() => setVendorName(item.name)}
                  />
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.note}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <button type="submit" className="k-action" disabled={busy}>
              Ask for a clearance
              <Arrow />
            </button>
          </form>
          <p className="k-terms">
            {`Payment terms. Category 7. Purpose 1001. Corridor US to US. Invoice currency USD at one dollar to one USDC. Budget ${BUDGET}.00. Per payment ${PER_PAYMENT}.00. Last payment ${lastPayment || "none"}.`}
            {lastClearance
              ? ` Clearance signed for ${baseToUsdc(usdcToBase(Number(amount) || 0))} USDC.`
              : ""}
          </p>
          <div className="k-actions">
            <button
              type="button"
              className="k-action k-action-ghost"
              onClick={() => run(deliverAndRelease)}
              disabled={busy}
            >
              Deliver and release
              <Arrow />
            </button>
          </div>
        </section>

        <section className="k-block" aria-labelledby="attack-title">
          <h2 id="attack-title">Three refusals</h2>
          <div className="k-attack">
            <div>
              <span>01</span>
              <h3>Swap the vendor</h3>
              <p>Take a real clearance and change only the vendor bytes.</p>
              <button
                type="button"
                className="k-action k-action-ghost"
                onClick={() => run(swapVendor)}
                disabled={busy}
              >
                Run the swap
                <Arrow />
              </button>
            </div>
            <div>
              <span>02</span>
              <h3>Disable the corridor</h3>
              <p>
                The honest gate refuses. A forced allow can still be signed.
              </p>
              <button
                type="button"
                className="k-action k-action-ghost"
                onClick={() => run(disableCorridor)}
                disabled={busy}
              >
                Close the corridor
                <Arrow />
              </button>
              <button
                type="button"
                className="k-action k-action-ghost"
                onClick={() => run(forceAllow)}
                disabled={busy}
              >
                Force an allow
                <Arrow />
              </button>
            </div>
            <div>
              <span>03</span>
              <h3>Revoke the mandate</h3>
              <p>The next funding fails. Open a new mandate to continue.</p>
              <button
                type="button"
                className="k-action k-action-ghost"
                onClick={() => run(revoke)}
                disabled={busy}
              >
                Revoke
                <Arrow />
              </button>
              <button
                type="button"
                className="k-action k-action-ghost"
                onClick={() =>
                  run(() => openMandate(session.current.mandateId + 1))
                }
                disabled={busy}
              >
                Open the next mandate
                <Arrow />
              </button>
            </div>
          </div>
        </section>

        <section className="k-block" aria-labelledby="log-title">
          <h2 id="log-title">Evidence on this page</h2>
          <div className="k-log" aria-live="polite">
            {log.length === 0 ? <p>No decision yet.</p> : null}
            {log.map((line, index) => (
              <article key={`${line.title}-${index}`}>
                <h3>{line.title}</h3>
                <p>{line.detail}</p>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

function reasonsOf(result: GateResult): string[] {
  const reasons = result.body.reasons;
  if (Array.isArray(reasons)) return reasons.map(String);
  if (typeof result.body.error === "string") return [result.body.error];
  return [];
}

function errorText(result: GateResult): string {
  return reasonsOf(result).join(", ") || `The gate returned ${result.status}.`;
}
