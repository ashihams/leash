import { useMemo, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import nacl from "tweetnacl";
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

export function Dashboard() {
  const { connectors, connect, disconnect, wallet, status } =
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

  const [mint, setMint] = useState("");
  const [gateState, setGateState] = useState("The gate has not been checked.");
  const [mandateId, setMandateId] = useState(7);
  const [mandateAccount, setMandateAccount] = useState("");
  const [mandateOwner, setMandateOwner] = useState("");
  const [vendorName, setVendorName] = useState(vendors[0].name);
  const [amount, setAmount] = useState("100");
  const [goal, setGoal] = useState("Buy a logo from a studio for 100 USDC.");
  const [busy, setBusy] = useState(false);
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
    setLog((current) => [{ title, detail }, ...current].slice(0, 8));
  }

  async function checkGate() {
    setBusy(true);
    try {
      const result = await gate("/health");
      if (result.status !== 200) {
        setGateState("The gate answered, but not with a health record.");
        return;
      }
      const reportedMint = String(result.body.mint ?? "");
      setMint(reportedMint);
      setGateState(
        `Gate is up. Policy signer ${String(result.body.policySigner ?? "")}.`
      );
    } catch {
      setGateState("The gate is not running. Start it with npm run server.");
    } finally {
      setBusy(false);
    }
  }

  async function openMandate(nextId = mandateId) {
    if (!mint) {
      push(
        "Mint missing",
        "Check the gate so the dashboard can use its test mint."
      );
      return;
    }
    setBusy(true);
    try {
      const mandate = await mandatePda(ownerAddress, nextId);
      const now = Math.floor(Date.now() / 1000);
      for (const item of vendors) {
        const registered = await gate("/vendors", {
          wallet: item.address,
          name: item.name,
          country: item.country,
          blocked: item.blocked,
        });
        if (registered.status >= 400) {
          push(item.name, errorText(registered));
          return;
        }
      }
      const corridor = await gate("/corridors", {
        fromCountry: "US",
        toCountry: "US",
        enabled: true,
        perPaymentCap: usdcToBase(PER_PAYMENT),
        dailyCap: usdcToBase(1000),
        packetThreshold: 0,
      });
      if (corridor.status >= 400) {
        push("Corridor", errorText(corridor));
        return;
      }
      const created = await gate("/mandates", {
        mandateId: nextId,
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
      if (created.status >= 400) {
        push("Mandate", errorText(created));
        return;
      }
      setMandateId(nextId);
      setMandateAccount(mandate);
      setMandateOwner(ownerAddress);
      push(
        "Mandate open",
        `Mandate ${nextId} for ${ownerAddress === connected ? "the connected wallet" : "the demo owner key"}. Budget ${BUDGET}.00 USDC.`
      );
    } catch (error) {
      push(
        "Mandate",
        error instanceof Error ? error.message : "Could not open the mandate."
      );
    } finally {
      setBusy(false);
    }
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
    if (!mandateAccount || mandateOwner !== ownerAddress) {
      push(
        "No mandate",
        "Open a mandate for this owner before asking for a payment."
      );
      return;
    }
    if (!Number.isFinite(usdc) || usdc <= 0) {
      push("Amount", "Enter a USDC amount greater than zero.");
      return;
    }
    setBusy(true);
    try {
      const paymentId = randomHex();
      const invoiceHash = randomHex();
      const base = usdcToBase(usdc);
      const fields = {
        paymentId,
        mandateId,
        mandate: mandateAccount,
        buyer: ownerAddress,
        vendor: chosen.address,
        mint,
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
          mandate: mandateAccount,
          buyer: ownerAddress,
          vendor: chosen.address,
          mint,
          amount: base,
          invoiceHash,
        }),
      };
      const result = await gate("/clearances/fund", fields);
      if (result.body.decision === "allow") {
        setLastPayment(paymentId);
        setFunded({ invoiceHash, amount: base, vendor: chosen.address });
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
    } catch (error) {
      push(
        "Clearance",
        error instanceof Error ? error.message : "The request failed."
      );
    } finally {
      setBusy(false);
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
    if (!lastPayment || !mandateAccount || !funded) return;
    setBusy(true);
    try {
      const artifact = new TextEncoder().encode(`DLV1${goal}`.slice(0, 256));
      const receiptHash = await sha256Hex(artifact);
      const delivered = await gate("/payments/delivery", {
        paymentId: lastPayment,
        receiptHash,
      });
      if (delivered.status >= 400) {
        push("Delivery", errorText(delivered));
        return;
      }
      const verified = await gate("/payments/verify", {
        paymentId: lastPayment,
        artifact: bytesToBase64(artifact),
      });
      if (verified.status >= 400) {
        push("Verifier", errorText(verified));
        return;
      }
      const release = await gate("/clearances/release", {
        paymentId: lastPayment,
        intentSignature: signIntent(agent.secretKey, {
          kind: 2,
          paymentId: lastPayment,
          mandate: mandateAccount,
          buyer: mandateOwner,
          vendor: funded.vendor,
          mint,
          amount: funded.amount,
          invoiceHash: funded.invoiceHash,
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
    } finally {
      setBusy(false);
    }
  }

  function swapVendor() {
    if (!lastClearance) {
      push("Swap", "Ask for a clearance first.");
      return;
    }
    const message = base64ToBytes(lastClearance.message);
    const signature = base64ToBytes(lastClearance.signature);
    const signer = decodeBase58(lastClearance.signer);
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
    setBusy(true);
    try {
      await gate("/corridors", {
        fromCountry: "US",
        toCountry: "US",
        enabled: false,
        perPaymentCap: usdcToBase(PER_PAYMENT),
        dailyCap: usdcToBase(1000),
        packetThreshold: 0,
      });
      push(
        "Corridor disabled",
        "The honest gate should now refuse the next funding."
      );
      await ask();
    } finally {
      setBusy(false);
    }
  }

  async function forceAllow() {
    if (!mandateAccount) {
      push("Force", "Open a mandate first.");
      return;
    }
    setBusy(true);
    try {
      const paymentId = randomHex();
      const invoiceHash = randomHex();
      const base = usdcToBase(Number(amount) || 100);
      const result = await gate("/demo/force-clearance", {
        kind: "fund",
        decision: "allow",
        paymentId,
        mandateId,
        mandate: mandateAccount,
        buyer: ownerAddress,
        vendor: vendor.address,
        mint,
        amount: base,
        fromCountry: "US",
        toCountry: "US",
        category: 7,
        purposeCode: 1001,
        invoiceHash,
        invoiceAmount: base,
        invoiceCurrency: "USD",
      });
      remember(result);
      push(
        "Forced allow",
        "The compromised signer path returned a signed allow. The program still enforces the corridor and the mandate."
      );
    } catch (error) {
      push("Force", error instanceof Error ? error.message : "Force failed.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    try {
      const result = await gate("/mandates/revoke", { mandateId });
      if (result.status >= 400) {
        push("Revoke", errorText(result));
        return;
      }
      push(
        "Mandate revoked",
        "The next honest funding should fail even if a signer is later forced."
      );
      await ask();
    } finally {
      setBusy(false);
    }
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
          <p className="k-status">
            {status === "connected" ? "Connected" : "Not connected"}
          </p>
          <div className="k-connectors">
            {connectors.map((connector) => (
              <button
                key={connector.id}
                type="button"
                className="k-action k-action-ghost"
                onClick={() => connect(connector.id)}
                disabled={status === "connecting" || busy}
              >
                {connector.name}
                <Arrow />
              </button>
            ))}
          </div>
          <p className="k-mono">
            {connected ?? "No wallet connected. The demo owner key is ready."}
          </p>
          <button
            type="button"
            className="k-action k-action-ghost"
            onClick={() => disconnect()}
            disabled={status !== "connected"}
          >
            Disconnect
            <Arrow direction="left" />
          </button>
        </section>

        <section className="k-block" aria-labelledby="gate-title">
          <h2 id="gate-title">Gate</h2>
          <p role="status">{gateState}</p>
          <p className="k-mono">Agent key {agentAddress}</p>
          <div className="k-actions">
            <button
              type="button"
              className="k-action"
              onClick={checkGate}
              disabled={busy}
            >
              Check the gate
              <Arrow />
            </button>
            <button
              type="button"
              className="k-action"
              onClick={() => openMandate()}
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
              void ask();
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
          <details className="k-details">
            <summary>Payment terms</summary>
            <p>
              {`Category 7. Purpose 1001. Corridor US to US. Invoice currency USD at one dollar to one USDC. Budget ${BUDGET}.00. Per payment ${PER_PAYMENT}.00. Last payment ${lastPayment || "none"}.`}
              {lastClearance
                ? ` Clearance signed for ${baseToUsdc(usdcToBase(Number(amount) || 0))} USDC.`
                : ""}
            </p>
          </details>
          <div className="k-actions">
            <button
              type="button"
              className="k-action k-action-ghost"
              onClick={deliverAndRelease}
              disabled={busy || !lastPayment}
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
                onClick={swapVendor}
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
                onClick={() => void disableCorridor()}
                disabled={busy}
              >
                Close the corridor
                <Arrow />
              </button>
              <button
                type="button"
                className="k-action k-action-ghost"
                onClick={() => void forceAllow()}
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
                onClick={() => void revoke()}
                disabled={busy}
              >
                Revoke
                <Arrow />
              </button>
              <button
                type="button"
                className="k-action k-action-ghost"
                onClick={() => void openMandate(mandateId + 1)}
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
