import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import nacl from "tweetnacl";
import { AgentPanel } from "./AgentPanel";
import { supabase } from "./lib/supabase";
import {
  agentFinalSchema,
  type AgentContext,
  type AgentResponse,
  type AgentStep,
} from "./leash/agent-contract";
import { paymentSetupIssue, type PaymentReadiness } from "./leash/readiness";
import {
  bannerFrom,
  mandateRecovery,
  markFor,
  type LogLine,
} from "./leash/evidence";
import { testVendorTampering } from "./leash/vendor-tampering";
import {
  CROSS_BORDER_ROUTES,
  formatLocalAmount,
  type FxQuote,
  type PaymentRoute,
} from "./leash/corridors";
import "./dashboard.css";
import { refreshPhantomChains, usePhantomChains } from "./providers";
import {
  base64ToBytes,
  baseToUsdc,
  bytesToBase64,
  gate,
  hexToBytes,
  pubkey,
  randomHex,
  sha256Hex,
  signIntent,
  usdcToBase,
  type GateResult,
} from "./leash/client";
import { decodeBase58 } from "../server/src/bytes.ts";
import { mandatePda } from "./leash/pda";
import {
  PHANTOM_INSTALL_URL,
  SOLANA_FAUCET_URL,
  DEVNET_GENESIS_HASH,
  LOW_SOL_LAMPORTS,
  accountChangeNote,
  afterWalletPrompt,
  describeWalletError,
  isPhantomName,
  mandateOwnerKind,
  phantomOnDevnet,
  transactionGuard,
  withWalletTimeout,
} from "./leash/wallet";
import {
  ChainRejected,
  accountExists,
  createAtaInstruction,
  createMandateInstruction,
  depositInstruction,
  deployRentPaid,
  explorerTx,
  fundIfNeeded,
  fundInstructions,
  lamportBalance,
  devnetRpcMatches,
  programIsDeployed,
  sendSignedByWallet,
  transferSolInstruction,
  releaseInstructions,
  revokeInstruction,
  sendLocal,
  submitDeliveryInstruction,
  tokenAmount,
  treasuryVaultPda,
} from "./leash/chain";

type Vendor = {
  name: string;
  country: string;
  blocked: boolean;
  note: string;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  address: string;
};

const BUDGET = 2;
const PER_PAYMENT = 1;
const PAYMENT = 1;

function getStoredMandateId() {
  try {
    const val = Number(localStorage.getItem("leash_mandate_id"));
    if (Number.isInteger(val) && val >= 7) return val;
  } catch {
    // Ignore storage failure
  }
  return 7;
}

function storeMandateId(id: number) {
  try {
    localStorage.setItem("leash_mandate_id", String(id));
  } catch {
    // Ignore storage failure
  }
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
        },
        {
          name: "Harbor Design",
          country: "US",
          blocked: false,
          note: "Demo design studio. An alternative registered payout wallet.",
        },
        {
          name: "Grey Market",
          country: "US",
          blocked: true,
          note: "Demo wallet blocked by local policy. OFAC screening is run separately.",
        },
      ].map((vendor) => {
        const pair = nacl.sign.keyPair();
        return {
          ...vendor,
          publicKey: pair.publicKey,
          secretKey: pair.secretKey,
          address: pubkey(pair.publicKey),
        };
      }),
    []
  );

  const [gateState, setGateState] = useState("The gate has not been checked.");
  const [setupIssue, setSetupIssue] =
    useState<ReturnType<typeof paymentSetupIssue>>(null);
  const [mandateId, setMandateId] = useState(getStoredMandateId);
  const [mandateAccount, setMandateAccount] = useState("");
  const [vendorName, setVendorName] = useState(vendors[0].name);
  const [amount, setAmount] = useState(String(PAYMENT));
  const [routeId, setRouteId] = useState<string>(CROSS_BORDER_ROUTES[0].id);
  const route =
    CROSS_BORDER_ROUTES.find((item) => item.id === routeId) ??
    CROSS_BORDER_ROUTES[0];
  const [fxQuote, setFxQuote] = useState<FxQuote | null>(null);
  const [fxError, setFxError] = useState("");
  const [fxRefresh, setFxRefresh] = useState(0);
  const [goal, setGoal] = useState("Buy a logo from a studio for 1 USDC.");
  const [busy, setBusy] = useState(false);
  const [walletNote, setWalletNote] = useState("");
  const [prompting, setPrompting] = useState(false);
  const connectLock = useRef(false);
  const actionLock = useRef(false);
  const accountButton = useRef<HTMLButtonElement>(null);
  const accountPanel = useRef<HTMLDivElement>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const session = useRef({
    mandateId: getStoredMandateId(),
    mandateAccount: "",
    mandateOwner: "",
    mandateRoutes: "",
    mint: "",
    verifier: "",
    corridorSet: "",
  });
  const [log, setLog] = useState<LogLine[]>([]);
  const [lastPayment, setLastPayment] = useState("");
  const [funded, setFunded] = useState<{
    invoiceHash: string;
    amount: number;
    vendor: string;
    route: PaymentRoute;
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
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      let nextRefresh = 60_000;
      setFxQuote(null);
      setFxError("");
      try {
        const response = await gate(`/fx/quote?currency=${route.currency}`);
        if (cancelled) return;
        const quote = response.body as unknown as FxQuote;
        if (
          response.status !== 200 ||
          quote.currency !== route.currency ||
          quote.base !== "USDC" ||
          !Number.isFinite(quote.rate) ||
          quote.rate <= 0 ||
          !Number.isFinite(Date.parse(quote.expiresAt)) ||
          Date.parse(quote.expiresAt) <= Date.now()
        )
          throw new Error("Market rate unavailable. Try again.");
        setFxQuote(quote);
        nextRefresh = Math.max(
          1000,
          Math.min(60_000, Date.parse(quote.expiresAt) - Date.now())
        );
      } catch {
        if (!cancelled) setFxError("Market rate unavailable. Try again.");
      } finally {
        if (!cancelled) timer = setTimeout(refresh, nextRefresh);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [route.currency, fxRefresh]);
  const chains = usePhantomChains();
  const [genesisOk, setGenesisOk] = useState<boolean | null>(null);
  const [programOnDevnet, setProgramOnDevnet] = useState<boolean | null>(null);
  const [rentPaid, setRentPaid] = useState(false);
  const [solBalance, setSolBalance] = useState<bigint | null>(null);

  function push(
    title: string,
    detail: string,
    signature?: string,
    testOutcome?: LogLine["testOutcome"]
  ) {
    setLog((current) =>
      [{ title, detail, signature, testOutcome }, ...current].slice(0, 12)
    );
  }

  async function sendOwner(instructions: Parameters<typeof sendLocal>[1]) {
    const guard = transactionGuard({
      genesis: genesisOk === true ? DEVNET_GENESIS_HASH : null,
      chains,
      connected: Boolean(connected),
    });
    if (!guard.ok && guard.reason === "rpc")
      throw new Error("RPC is not devnet");
    if (!guard.ok) {
      throw new Error(
        "Switch Phantom to Devnet before signing. Open Settings, then Developer Settings, then Testnet Mode."
      );
    }
    if (!(await programIsDeployed())) {
      throw new Error(
        "The Leash program is missing on devnet. Complete deployment before retrying. No payment or deployment funding was sent."
      );
    }
    if (connected && wallet?.signTransaction) {
      const signTransaction = wallet.signTransaction;
      return withWalletTimeout(
        sendSignedByWallet(
          (transaction) => signTransaction(transaction as never),
          instructions,
          ownerAddress
        )
      );
    }
    const sent = await sendLocal(demoOwner.secretKey, instructions);
    if (sent.airdrop)
      push("Airdrop", "Requested devnet SOL for the fee.", sent.airdrop);
    return sent.signature;
  }

  async function recordTx(
    title: string,
    detail: string,
    work: () => Promise<string>
  ) {
    try {
      const signature = await work();
      push(title, detail, signature);
      return true;
    } catch (error) {
      if (error instanceof ChainRejected) {
        push(title, error.message, error.signature);
      } else {
        push(title, describeWalletError(error));
      }
      return false;
    }
  }

  async function sponsor(publicKey: string) {
    if ((await lamportBalance(publicKey)) >= 20_000_000n) return;
    const airdrop = await fundIfNeeded(publicKey);
    if (airdrop) push("Airdrop", "Requested devnet SOL for the fee.", airdrop);
    if ((await lamportBalance(publicKey)) >= 20_000_000n) return;
    if (!connected) {
      throw new Error(
        "This key has no devnet SOL. Connect a wallet that already has devnet SOL. The public faucet no longer airdrops without a GitHub sign-in."
      );
    }
    const signature = await sendOwner([
      transferSolInstruction(ownerAddress, publicKey, 50_000_000),
    ]);
    push(
      "Fee",
      "Sent devnet SOL from the connected wallet to pay the fee.",
      signature
    );
  }

  async function prepareTreasury(
    ready: { id: number; account: string; owner: string; mint: string },
    needed: number
  ) {
    if (!(await accountExists(ready.account))) {
      const opened = await recordTx(
        "Mandate account",
        `Created mandate ${ready.id} on devnet.`,
        async () =>
          sendOwner([
            await createMandateInstruction({
              owner: ready.owner,
              mandate: ready.account,
              mandateId: ready.id,
              agent: agentAddress,
              mint: ready.mint,
              budget: usdcToBase(BUDGET),
              perPayment: usdcToBase(PER_PAYMENT),
              expiresAt: Math.floor(Date.now() / 1000) + 86_400 * 10,
            }),
          ])
      );
      if (!opened) return false;
    }
    const held = await tokenAmount(await treasuryVaultPda(ready.account));
    if (held >= needed) return true;
    const minted = await gate("/chain/mint", { owner: ready.owner });
    if (minted.status >= 400) {
      push("Test USDC", errorText(minted));
      return false;
    }
    if (typeof minted.body.signature === "string") {
      push(
        "Test USDC",
        "Minted test USDC into the owner account on devnet.",
        minted.body.signature
      );
    }
    return recordTx(
      "Deposit",
      "Deposited test USDC into the treasury.",
      async () =>
        sendOwner([
          await createAtaInstruction(ready.owner, ready.owner, ready.mint),
          await depositInstruction({
            owner: ready.owner,
            mandate: ready.account,
            mandateId: ready.id,
            mint: ready.mint,
            amount: usdcToBase(BUDGET),
          }),
        ])
    );
  }

  async function submitFund(
    ready: { id: number; account: string; owner: string; mint: string },
    paymentId: string,
    vendorAddress: string,
    instructionData: string,
    title: string
  ) {
    return recordTx(title, "Submitted create_and_fund on devnet.", async () => {
      await sponsor(agentAddress);
      const instructions = await fundInstructions({
        route,
        agent: agentAddress,
        owner: ready.owner,
        mandate: ready.account,
        mandateId: ready.id,
        mint: ready.mint,
        vendor: vendorAddress,
        paymentId: hexToBytes(paymentId),
        ed25519: base64ToBytes(instructionData),
      });
      return (await sendLocal(agent.secretKey, instructions)).signature;
    });
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
    session.current.mint = "";
    const result = await gate("/health");
    if (result.status !== 200) {
      setGateState("The gate answered, but not with a health record.");
      return "";
    }
    const reportedMint = String(result.body.mint ?? "");
    session.current.verifier = String(result.body.verifier ?? "");
    setGateState(
      `Gate is up. Policy signer ${String(result.body.policySigner ?? "")}.`
    );
    const readiness = await gate("/health/chain");
    const issue =
      readiness.status === 200
        ? paymentSetupIssue(
            readiness.body as unknown as PaymentReadiness,
            route.id
          )
        : {
            title: "Readiness check unavailable",
            detail:
              readiness.status === 404
                ? "The backend needs an update or restart before it can check payment readiness."
                : "The backend could not verify devnet readiness. Retry the gate check before making a payment.",
          };
    setSetupIssue(issue);
    if (issue) return "";
    session.current.mint = reportedMint;
    return reportedMint;
  }, [route.id]);

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
    let cancelled = false;
    let timer = 0;
    const check = () => {
      Promise.all([programIsDeployed(), deployRentPaid()])
        .then(([ready, paid]) => {
          if (cancelled) return;
          setProgramOnDevnet(ready);
          setRentPaid(paid);
          if (!ready) timer = window.setTimeout(check, 15000);
        })
        .catch(() => {
          if (!cancelled) timer = window.setTimeout(check, 15000);
        });
    };
    check();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const check = () => {
      devnetRpcMatches().then((ok) => {
        if (cancelled) return;
        if (ok === null) {
          timer = window.setTimeout(check, 4000);
          return;
        }
        setGenesisOk(ok);
      });
    };
    check();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!connected) {
      setSolBalance(null);
      return;
    }
    let cancelled = false;
    lamportBalance(connected)
      .then((balance) => {
        if (!cancelled) setSolBalance(balance);
      })
      .catch(() => {
        if (!cancelled) setSolBalance(null);
      });
    return () => {
      cancelled = true;
    };
  }, [connected]);

  useEffect(() => {
    if (status === "connected") refreshPhantomChains();
  }, [status, connected]);

  useEffect(() => {
    if (!wallet?.onAccountsChanged || !connected) return;
    return wallet.onAccountsChanged((accounts) => {
      const next = accounts[0]?.address?.toString() ?? "";
      const note = accountChangeNote(connected, next);
      if (note) setWalletNote(note);
    });
  }, [wallet, connected]);

  useEffect(() => {
    if (!accountOpen) return;
    const panel = accountPanel.current;
    panel?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAccountOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel?.contains(target) || accountButton.current?.contains(target))
        return;
      setAccountOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [accountOpen]);

  async function checkGate() {
    try {
      await readGate();
    } catch {
      setGateState("The gate is not running. Start it with npm run server.");
    }
  }

  async function loadMint() {
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
        country: route.toCountry,
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
      fromCountry: route.fromCountry,
      toCountry: route.toCountry,
      enabled,
      perPaymentCap: usdcToBase(PER_PAYMENT),
      dailyCap: usdcToBase(10000),
      packetThreshold: 0,
    });
    if (result.status >= 400) {
      push("Corridor", errorText(result));
      return false;
    }
    session.current.corridorSet = route.id;
    return true;
  }

  async function ensureMandate(startId: number, reopenCorridor: boolean) {
    const activeMint = await loadMint();
    if (!activeMint) {
      push(
        "Payment setup blocked",
        "Check the payment readiness notice above. No wallet transaction was requested."
      );
      return null;
    }
    if (!(await registerVendors())) return null;
    if (reopenCorridor || session.current.corridorSet !== route.id) {
      if (!(await writeCorridor(true))) return null;
    }
    const who =
      ownerAddress === connected
        ? "the connected wallet"
        : "the demo owner key";
    if (
      session.current.mandateAccount &&
      session.current.mandateOwner === ownerAddress &&
      session.current.mandateRoutes ===
        CROSS_BORDER_ROUTES.map((item) => item.id).join(",") &&
      (startId === session.current.mandateId || !reopenCorridor)
    ) {
      if (reopenCorridor) {
        push(
          "Mandate selected",
          `Mandate ${session.current.mandateId} is registered in the gate for ${who}. Budget ${BUDGET}.00 USDC.`
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
      for (let attempt = 0; attempt < 120; attempt += 1) {
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
          corridors: CROSS_BORDER_ROUTES.map(({ fromCountry, toCountry }) => ({
            fromCountry,
            toCountry,
          })),
        });
        const err = errorText(created).toLowerCase();
        const isDuplicate =
          created.status === 409 ||
          err.includes("mandate_exists") ||
          err.includes("unique") ||
          err.includes("duplicate") ||
          err.includes("already exists") ||
          (created.status === 500 &&
            (err.includes("unique") ||
              err.includes("duplicate") ||
              err.includes("key") ||
              err.includes("exists")));
        if (isDuplicate) {
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
        session.current.mandateRoutes = CROSS_BORDER_ROUTES.map(
          (item) => item.id
        ).join(",");
        setMandateId(id);
        setMandateAccount(mandate);
        storeMandateId(id);
        setLastClearance(null);
        setLastPayment("");
        setFunded(null);
        push(
          "Mandate registered",
          skipped.length > 0
            ? `${skippedLabel(skipped)} Mandate ${id} is registered in the gate for ${who}. Solana devnet is connected. Click "Open a mandate" or "Run agent" to initialize on-chain (Budget ${BUDGET}.00 USDC).`
            : `Mandate ${id} is registered in the gate for ${who}. Solana devnet is connected. Click "Open a mandate" or "Run agent" to initialize on-chain (Budget ${BUDGET}.00 USDC).`
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
    session.current.mandateId = id;
    setMandateId(id);
    storeMandateId(id);
    push(
      "Mandate",
      `${skippedLabel(skipped)} No free mandate id was left in that search.`
    );
    return null;
  }

  async function openMandate(nextId = session.current.mandateId) {
    const ready = await ensureMandate(nextId, true);
    if (ready) await prepareTreasury(ready, usdcToBase(BUDGET));
    return ready;
  }

  async function runAgentProposal(
    agentGoal: string,
    simulate: boolean
  ): Promise<AgentResponse> {
    if (actionLock.current)
      throw new Error("Wait for the current action to finish.");
    actionLock.current = true;
    setBusy(true);
    try {
      const token = (await supabase?.auth.getSession())?.data.session
        ?.access_token;
      const ready = await ensureMandate(session.current.mandateId, false);
      if (!ready)
        throw new Error(
          "Complete mandate and route setup before running the agent."
        );
      // Finite proposals prepared by the existing browser signer. No private key
      // or signing capability is given to the server or to the language model.
      const goalAmounts = [
        ...agentGoal.matchAll(/(\d+(?:\.\d{1,6})?)\s*USDC/gi),
      ].map((m) => Number(m[1]));
      const amounts = [
        ...new Set([Number(amount), PER_PAYMENT, ...goalAmounts]),
      ]
        .filter((n) => Number.isFinite(n) && n > 0 && n <= PER_PAYMENT)
        .slice(0, 5);
      const intents: AgentContext["intents"] = [];
      if (!simulate)
        for (const candidate of vendors)
          for (const value of amounts) {
            if (candidate.blocked) continue;
            const paymentId = randomHex(),
              invoiceHash = randomHex(),
              base = usdcToBase(value);
            intents.push({
              vendor: candidate.address,
              amount: base,
              paymentId,
              invoiceHash,
              intentSignature: signIntent(agent.secretKey, {
                kind: 1,
                paymentId,
                invoiceHash,
                mandate: ready.account,
                buyer: ready.owner,
                vendor: candidate.address,
                mint: ready.mint,
                amount: base,
                fromCountry: route.fromCountry,
                toCountry: route.toCountry,
              }),
            });
          }
      const result = await gate(
        "/agent/run",
        {
          goal: agentGoal,
          simulate_compromised: simulate,
          context: {
            mandate_id: ready.id,
            vendor_wallets: vendors.map((v) => v.address),
            corridor: {
              fromCountry: route.fromCountry,
              toCountry: route.toCountry,
            },
            intents,
          },
        },
        token
      );
      if (result.status !== 200) {
        const failure = new Error(
          String(result.body.error ?? "Agent unavailable")
        ) as Error & { steps?: AgentStep[] };
        failure.steps = Array.isArray(result.body.steps)
          ? (result.body.steps as AgentStep[])
          : [];
        throw failure;
      }
      const response = result.body as unknown as AgentResponse;
      agentFinalSchema.parse(response.final);
      return response;
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }

  async function approveAgentProposal(proposal: AgentResponse) {
    if (actionLock.current)
      throw new Error("Wait for the current action to finish.");
    const candidate = vendors.find(
      (v) => v.address === proposal.final.chosen_vendor && !v.blocked
    );
    if (
      proposal.label === "SIMULATION" ||
      proposal.final.gate_result.decision !== "allow" ||
      !proposal.confirmation ||
      !candidate
    )
      throw new Error("This proposal cannot be funded.");
    if (
      proposal.review.owner !== ownerAddress ||
      proposal.review.mandate !== session.current.mandateAccount ||
      proposal.review.mandate_id !== session.current.mandateId ||
      proposal.review.corridor.fromCountry !== route.fromCountry ||
      proposal.review.corridor.toCountry !== route.toCountry
    )
      throw new Error(
        "The wallet, mandate or corridor changed. Run the agent again."
      );
    if (proposal.confirmation.expires_at <= Date.now() / 1000)
      throw new Error(
        "The clearance expired. Request a new proposal before funding."
      );
    actionLock.current = true;
    setBusy(true);
    try {
      const mint = await loadMint();
      if (!mint) throw new Error("Payment readiness could not be verified.");
      const ready = {
        id: proposal.review.mandate_id,
        account: proposal.review.mandate,
        owner: proposal.review.owner,
        mint,
      };
      if (!(await prepareTreasury(ready, usdcToBase(BUDGET))))
        throw new Error("Treasury setup was not completed.");
      if (proposal.confirmation.expires_at <= Date.now() / 1000)
        throw new Error(
          "The clearance expired during setup. Request a new proposal."
        );
      if (
        !(await submitFund(
          ready,
          proposal.confirmation.payment_id,
          candidate.address,
          proposal.confirmation.instruction_data,
          "Fund"
        ))
      )
        throw new Error(
          "Funding was not confirmed. Check Evidence before retrying."
        );
      setLastPayment(proposal.confirmation.payment_id);
      setFunded({
        invoiceHash: proposal.confirmation.invoice_hash,
        amount: usdcToBase(proposal.final.amount),
        vendor: candidate.address,
        route: proposal.review.corridor,
      });
      setLastClearance(null);
      setVendorName(candidate.name);
      setAmount(String(proposal.final.amount));
    } finally {
      actionLock.current = false;
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
    if (!Number.isFinite(usdc) || usdc <= 0) {
      push("Amount", "Enter a USDC amount greater than zero.");
      return null;
    }
    if (
      !fxQuote ||
      fxQuote.currency !== route.currency ||
      Date.parse(fxQuote.expiresAt) <= Date.now()
    ) {
      push(
        "Market rate unavailable",
        "Refresh the market rate before requesting this cross-border payment."
      );
      return null;
    }
    const ready = await ensureMandate(session.current.mandateId, false);
    if (!ready) return null;
    setLastClearance(null);
    const screening = await gate(`/vendors/${chosen.address}/checks`, {});
    if (typeof screening.body.paymentId === "string")
      await showProviderEvidence(screening.body.paymentId);
    if (screening.status >= 400 || screening.body.ok !== true) {
      const reasons = Array.isArray(screening.body.reasons)
        ? screening.body.reasons.join(", ")
        : String(
            screening.body.reason ?? screening.body.error ?? "CHECK_UNAVAILABLE"
          );
      push(`${chosen.name} · Deny`, reasons);
      return null;
    }
    // Blocked vendors must reach the gate's refusal without wallet setup prompts.
    if (!chosen.blocked && !(await prepareTreasury(ready, usdcToBase(BUDGET))))
      return null;
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
        fromCountry: route.fromCountry,
        toCountry: route.toCountry,
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
          fromCountry: route.fromCountry,
          toCountry: route.toCountry,
        }),
      };
      const result = await gate("/clearances/fund", fields);
      await showProviderEvidence(paymentId);
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
      setLastClearance(chosen.blocked ? null : clearance);
      const reasons = reasonsOf(result);
      push(
        `${chosen.name} · ${result.body.decision === "allow" ? "Allow" : "Deny"}`,
        reasons.length > 0 ? reasons.join(", ") : "The gate signed an allow."
      );
      if (reasons.includes("VENDOR_BLOCKED")) {
        push(
          "Vendor blocked",
          `${chosen.name} is blocked. No transaction was requested. Choose another vendor to continue.`
        );
      } else if (mandateRecovery(reasons)) {
        push("Adapt", mandateRecovery(reasons)!);
      } else if (reasons.includes("PAYMENT_LIMIT")) {
        setAmount(String(PAYMENT));
        push(
          "Adapt",
          "That amount is outside the leash. The field is back to 1 USDC."
        );
      } else if (reasons.includes("DAILY_CAP")) {
        push(
          "Adapt",
          `The ${route.fromCountry} to ${route.toCountry} corridor has already committed its daily amount.`
        );
      } else if (reasons.includes("CORRIDOR_BLOCKED")) {
        push("Adapt", "The corridor is closed. Reopen it, or stop.");
      }
      if (
        result.body.decision === "allow" &&
        typeof result.body.instructionData === "string"
      ) {
        if (chosen.blocked) {
          push(
            "Payment refused",
            "The selected vendor is blocked. No transaction was requested."
          );
          return null;
        }
        if (
          !(await submitFund(
            ready,
            paymentId,
            chosen.address,
            result.body.instructionData,
            "Fund"
          ))
        )
          return null;
        setLastPayment(paymentId);
        setFunded({
          invoiceHash,
          amount: base,
          vendor: chosen.address,
          route: { fromCountry: route.fromCountry, toCountry: route.toCountry },
        });
      } else if (result.body.decision === "allow") {
        push(
          "Fund failed",
          "The gate returned no transaction instruction. No payment was sent."
        );
        return null;
      }
      return {
        decision: String(result.body.decision ?? "deny"),
        paymentId,
        invoiceHash,
        amount: base,
        vendor: chosen.address,
        route: { fromCountry: route.fromCountry, toCountry: route.toCountry },
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

  async function showProviderEvidence(paymentId: string) {
    const evidence = await gate(`/evidence/${paymentId}`);
    if (!Array.isArray(evidence.body.providerChecks)) return;
    for (const raw of evidence.body.providerChecks) {
      const check = raw as Record<string, unknown>;
      push(
        `${String(check.provider).toUpperCase()} · ${check.status === "pass" ? "Pass" : "Refused"}`,
        String(check.publicNote || check.reasonCode || "Provider check passed.")
      );
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
    if (vendor.blocked || (funded && funded.vendor !== vendor.address)) {
      push(
        "Release refused",
        "Select the vendor of the funded payment before releasing it. Blocked vendors cannot receive a payment."
      );
      return;
    }
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
        route: fundedPayment.route,
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
      if (failed(delivered)) {
        push("Delivery", errorText(delivered));
        return;
      }
      const payout = vendors.find((item) => item.address === payment.vendor);
      if (!payout) {
        push(
          "Delivery",
          "This page no longer has the vendor key for that payout."
        );
        return;
      }
      const submitted = await recordTx(
        "Delivery",
        "Submitted the delivery receipt on devnet.",
        async () => {
          await sponsor(payout.address);
          const sent = await sendLocal(payout.secretKey, [
            await submitDeliveryInstruction({
              vendor: payout.address,
              owner: buyer,
              mandate: account,
              mandateId: session.current.mandateId,
              paymentId: hexToBytes(paymentId),
              receiptHash: hexToBytes(receiptHash),
            }),
          ]);
          return sent.signature;
        }
      );
      if (!submitted) return;
      const verified = await gate("/payments/verify", {
        paymentId,
        artifact: bytesToBase64(artifact),
      });
      if (failed(verified)) {
        push("Verifier", errorText(verified));
        return;
      }
      if (!session.current.verifier)
        throw new Error("The gate did not report its verifier wallet.");
      await sponsor(session.current.verifier);
      const chainVerify = await gate("/chain/verify", {
        paymentId,
        artifact: bytesToBase64(artifact),
      });
      if (chainVerify.status >= 400) {
        push("Verifier", errorText(chainVerify));
        return;
      }
      if (typeof chainVerify.body.signature === "string") {
        push(
          "Verifier",
          "The verifier account marked the delivery on devnet.",
          chainVerify.body.signature
        );
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
          fromCountry: payment.route.fromCountry,
          toCountry: payment.route.toCountry,
        }),
      });
      push(
        release.body.decision === "allow" ? "Release allow" : "Release refused",
        reasonsOf(release).join(", ") || "The gate signed the release."
      );
      if (
        release.body.decision === "allow" &&
        typeof release.body.instructionData === "string"
      ) {
        const released = await recordTx(
          "Release",
          "Submitted the release on devnet.",
          async () => {
            await sponsor(agentAddress);
            const instructions = await releaseInstructions({
              route: payment.route,
              agent: agentAddress,
              vendor: payment.vendor,
              mint: activeMint,
              paymentId: hexToBytes(paymentId),
              ed25519: base64ToBytes(release.body.instructionData as string),
            });
            return (await sendLocal(agent.secretKey, instructions)).signature;
          }
        );
        if (released) {
          setFunded(null);
          setLastClearance(null);
        }
      }
    } catch (error) {
      push(
        "Release",
        error instanceof Error ? error.message : "Release failed."
      );
    }
  }

  async function swapVendor() {
    if (!lastClearance) {
      push(
        "Vendor test unavailable",
        "Request a clearance before testing vendor protection.",
        undefined,
        "unavailable"
      );
      return;
    }
    try {
      const result = testVendorTampering(
        base64ToBytes(lastClearance.message),
        base64ToBytes(lastClearance.signature),
        decodeBase58(lastClearance.signer),
        vendors.map((item) => item.publicKey)
      );
      push(result.title, result.detail, undefined, result.testOutcome);
    } catch {
      push(
        "Vendor test unavailable",
        "The saved clearance could not be read. Request a new clearance before testing.",
        undefined,
        "unavailable"
      );
    }
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
      const base = usdcToBase(Number(amount) || PAYMENT);
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
        fromCountry: route.fromCountry,
        toCountry: route.toCountry,
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
      if (typeof result.body.instructionData === "string") {
        await prepareTreasury(ready, base);
        await submitFund(
          ready,
          paymentId,
          vendor.address,
          result.body.instructionData,
          "Forced fund"
        );
      }
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
    if (await accountExists(ready.account)) {
      await recordTx("Revoke", "Revoked the mandate on devnet.", async () =>
        sendOwner([
          await revokeInstruction({
            owner: ready.owner,
            mandate: ready.account,
            mandateId: ready.id,
          }),
        ])
      );
    }
    await ask();
  }

  function retryFailed() {
    const title = log[0]?.title ?? "";
    if (
      title === "Clearance" ||
      title === "Amount" ||
      title === "Fund" ||
      title === "Deposit" ||
      title === "Test USDC" ||
      title === "Mandate account"
    ) {
      return ask();
    }
    if (title === "Release" || title === "Delivery" || title === "Verifier") {
      return deliverAndRelease();
    }
    if (title === "Force" || title === "Forced fund") return forceAllow();
    if (title === "Revoke") return revoke();
    return checkGate();
  }

  const gateUp = gateState.startsWith("Gate is up");
  const gateChecking = gateState.startsWith("The gate has not");
  const gateDown = /not running|not with a health/.test(gateState);
  const policySigner = gateUp
    ? gateState.slice("Gate is up. Policy signer ".length).replace(/\.$/, "")
    : "";
  const gateSummary = gateChecking
    ? "Checking the gate."
    : gateUp
      ? mandateAccount
        ? "Gate is up. Mandate registered."
        : "Gate is up. No mandate yet."
      : "Gate is down.";
  const storeLabel =
    import.meta.env.VITE_GATE_URL === "/api/gate" ||
    (!import.meta.env.DEV && !import.meta.env.VITE_GATE_URL)
      ? "Supabase"
      : "local gate";
  const banner = bannerFrom(log);
  const reasonCodes = banner ? reasonCodesIn(banner.detail) : [];
  const callFailed =
    gateDown ||
    (log[0]
      ? [
          "Clearance",
          "Release",
          "Force",
          "Forced fund",
          "Revoke",
          "Mandate",
          "Mandate account",
          "Gate",
          "Delivery",
          "Verifier",
          "Amount",
          "Corridor",
          "Fund",
          "Deposit",
          "Test USDC",
        ].includes(log[0].title) &&
        /fail|rejected|not running|did not|refused|Could not|Enter a|nothing to|returned|No free|CHAIN_/i.test(
          log[0].detail
        )
      : false);
  const phantom = connectors.find((connector) => isPhantomName(connector.name));
  const phantomOffDevnet =
    Boolean(connected) && chains.length > 0 && !phantomOnDevnet(chains);
  const txOff = busy || genesisOk !== true || phantomOffDevnet;
  const walletLabel = prompting
    ? "Waiting for Phantom"
    : connected
      ? shorten(connected)
      : "Wallet";

  return (
    <div className="k-page d-shell">
      <header className="d-bar">
        <a className="d-word" href="#/">
          LEASH
        </a>
        <nav className="d-nav" aria-label="Pages">
          <a href="#/">Landing</a>
          <a href="#/dashboard" aria-current="page">
            Dashboard
          </a>
        </nav>
        <div className="d-status">
          <span className="d-badge">Devnet</span>
          <span
            className={gateUp ? "d-chip d-chip-up" : "d-chip"}
            role="status"
          >
            <Dot on={gateUp} />
            {gateChecking ? "Checking" : gateUp ? "Up" : "Down"}
          </span>
          <button
            ref={accountButton}
            type="button"
            className="d-btn d-btn-secondary d-wallet"
            aria-expanded={accountOpen}
            aria-controls="account-panel"
            title={
              connected ?? "No wallet connected. The demo owner key is ready."
            }
            onClick={() => setAccountOpen((open) => !open)}
          >
            {walletLabel}
          </button>
        </div>
        {accountOpen ? (
          <div
            ref={accountPanel}
            id="account-panel"
            className="d-popover"
            role="dialog"
            aria-label="Wallet and account"
            tabIndex={-1}
          >
            <section aria-labelledby="wallet-title">
              <p className="d-section-title" id="wallet-title">
                Wallet
              </p>
              <p className="d-note">
                This page drives the compliance gate, then submits the matching
                instruction on devnet. Connect Phantom when you want that
                address to own the mandate and pay the fee. Otherwise the demo
                owner key is used, and it is not your wallet.
              </p>
              <p className="d-status-line" role="status">
                {status === "connected"
                  ? "Connected"
                  : prompting
                    ? "Waiting for Phantom"
                    : "Not connected"}
              </p>
              {prompting ? (
                <p role="status">
                  Approve the request in Phantom. The prompt closes on its own
                  after 60 seconds.
                </p>
              ) : null}
              {walletNote || (error ? describeWalletError(error) : "") ? (
                <p role="status">{walletNote || describeWalletError(error)}</p>
              ) : null}
              {!phantom ? (
                <p>
                  Phantom is not installed.{" "}
                  <a
                    href={PHANTOM_INSTALL_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Install Phantom
                  </a>
                  . The demo owner key still works.
                </p>
              ) : null}
              <div className="d-actions">
                <button
                  type="button"
                  className="d-btn d-btn-secondary"
                  onClick={() => {
                    if (!phantom) {
                      setWalletNote(
                        afterWalletPrompt(
                          new Error("Phantom is not installed.")
                        ).message || "Phantom is not installed."
                      );
                      return;
                    }
                    if (connectLock.current || prompting) return;
                    connectLock.current = true;
                    setPrompting(true);
                    setWalletNote("");
                    withWalletTimeout(connect(phantom.id))
                      .catch(async (caught: unknown) => {
                        setWalletNote(afterWalletPrompt(caught).message);
                        const message =
                          caught instanceof Error ? caught.message : "";
                        if (/timed out/i.test(message)) {
                          await Promise.race([
                            disconnect().catch(() => undefined),
                            new Promise((resolve) => setTimeout(resolve, 1500)),
                          ]);
                        }
                      })
                      .finally(() => {
                        connectLock.current = false;
                        setPrompting(false);
                      });
                  }}
                  disabled={prompting}
                >
                  Connect Phantom
                </button>
                <button
                  type="button"
                  className="d-btn d-btn-ghost"
                  onClick={() => {
                    if (status !== "connected") {
                      push(
                        "Wallet",
                        mandateOwnerKind(connected) === "demo"
                          ? "No wallet is connected. Connect Phantom, or keep the demo owner key."
                          : "No wallet is connected."
                      );
                      return;
                    }
                    setPrompting(true);
                    withWalletTimeout(disconnect())
                      .then(() => {
                        push(
                          "Wallet",
                          "Disconnected. The demo owner key is the mandate owner again."
                        );
                      })
                      .catch((caught: unknown) =>
                        setWalletNote(afterWalletPrompt(caught).message)
                      )
                      .finally(() => setPrompting(false));
                  }}
                >
                  Disconnect
                </button>
              </div>
              <p className="d-mono" title={connected ?? undefined}>
                {connected
                  ? shorten(connected)
                  : "No wallet connected. The demo owner key is ready."}
                {connected ? (
                  <CopyButton value={connected} label="wallet address" />
                ) : null}
              </p>
              {connected && solBalance !== null ? (
                <p>
                  Devnet balance{" "}
                  {(Number(solBalance) / 1_000_000_000).toFixed(4)} SOL.
                  {solBalance < LOW_SOL_LAMPORTS ? (
                    <>
                      {" "}
                      <a
                        href={SOLANA_FAUCET_URL}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Get devnet SOL
                      </a>
                      .
                    </>
                  ) : null}
                </p>
              ) : null}
            </section>
          </div>
        ) : null}
      </header>
      <main id="content" className="d-workspace">
        {setupIssue ? (
          <p className="d-error" role="alert">
            <strong>{setupIssue.title}.</strong> {setupIssue.detail}
          </p>
        ) : null}
        {genesisOk === false ? (
          <p className="d-error" role="alert">
            RPC is not devnet
          </p>
        ) : null}
        {programOnDevnet === false ? (
          <p className="d-error" role="status">
            {rentPaid
              ? "The Leash program is missing on devnet. Rent is already paid, but deployment must finish before payments can run. Do not send more SOL."
              : "The Leash program is missing on devnet. Complete deployment before making a payment."}
          </p>
        ) : null}
        {phantomOffDevnet ? (
          <p className="d-error" role="alert">
            Switch Phantom to Devnet. Open Settings, then Developer Settings,
            then Testnet Mode.
          </p>
        ) : null}
        <details className="d-card d-gate">
          <summary>
            <span className="d-card-kicker">Gate and mandate</span>
            <span className="d-summary">{gateSummary}</span>
          </summary>
          <div className="d-card-body">
            <p role="status">{gateState}</p>
            <p className="d-muted">Devnet · {storeLabel}</p>
            <KeyLine label="Policy signer" value={policySigner} />
            <KeyLine label="Agent key" value={agentAddress} />
            {mandateAccount ? (
              <KeyLine label={`Mandate ${mandateId}`} value={mandateAccount} />
            ) : null}
            <div className="d-actions">
              <button
                type="button"
                className="d-btn d-btn-secondary"
                onClick={() => run(checkGate)}
                disabled={busy}
                aria-busy={busy}
              >
                {busy ? <Spinner /> : null}
                Check the gate
              </button>
              <button
                type="button"
                className="d-btn d-btn-secondary"
                onClick={() => run(() => openMandate())}
                disabled={txOff}
                aria-busy={busy}
              >
                {busy ? <Spinner /> : null}
                Open a mandate
              </button>
            </div>
          </div>
        </details>

        <section className="d-card d-pay" aria-labelledby="payment-title">
          <h1 id="payment-title">Payment</h1>
          <form
            className="d-form"
            onSubmit={(event) => {
              event.preventDefault();
              run(() => ask().then(() => undefined));
            }}
          >
            <label htmlFor="goal">Goal</label>
            <textarea
              id="goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              rows={2}
            />
            <AgentPanel
              goal={goal}
              busy={busy}
              runAgent={runAgentProposal}
              approve={approveAgentProposal}
            />
            <label htmlFor="payment-route">Cross-border route</label>
            <select
              id="payment-route"
              value={routeId}
              disabled={busy}
              onChange={(event) => {
                setRouteId(event.target.value);
                setLastClearance(null);
              }}
            >
              {CROSS_BORDER_ROUTES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.fromCountry} → {item.toCountry} · {item.label} ·{" "}
                  {item.currency}
                </option>
              ))}
            </select>
            <label htmlFor="amount">You send · test USDC</label>
            <input
              id="amount"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <div className="d-fx-quote" aria-live="polite">
              <span className="d-section-title">
                Recipient currency estimate
              </span>
              <strong>
                {fxQuote?.currency === route.currency
                  ? formatLocalAmount(Number(amount), fxQuote)
                  : "—"}
              </strong>
              {fxQuote?.currency === route.currency ? (
                <>
                  <span>1 USDC ≈ {formatLocalAmount(1, fxQuote)}</span>
                  <small>
                    Coinbase market rate · fetched{" "}
                    {new Date(fxQuote.fetchedAt).toLocaleTimeString()} ·
                    refreshes automatically
                  </small>
                </>
              ) : (
                <span>{fxError || "Fetching the current market rate…"}</span>
              )}
              <small>
                Settlement is in test USDC. This currency estimate excludes
                conversion fees and is not a bank payout or a locked exchange
                quote.
              </small>
              <button
                type="button"
                className="d-btn d-btn-ghost"
                disabled={busy}
                onClick={() => setFxRefresh((value) => value + 1)}
              >
                Refresh rate
              </button>
            </div>
            <fieldset className="d-vendors">
              <legend>Vendor</legend>
              <div
                className="d-vendor-row"
                role="radiogroup"
                aria-label="Vendor"
              >
                {vendors.map((item) => (
                  <label
                    className={
                      vendorName === item.name
                        ? "d-vendor is-selected"
                        : "d-vendor"
                    }
                    key={item.address}
                  >
                    <input
                      type="radio"
                      name="vendor"
                      value={item.name}
                      checked={vendorName === item.name}
                      onChange={() => setVendorName(item.name)}
                    />
                    <span className="d-vendor-name">{item.name}</span>
                    <span className="d-vendor-note" title={item.note}>
                      {item.note}
                    </span>
                    <span
                      className={item.blocked ? "d-tag d-tag-warn" : "d-tag"}
                    >
                      {item.blocked
                        ? "On block list: expect a refusal"
                        : "Registered payout wallet"}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="d-hint">
              Vendor choices are mock payout wallets. The gate screens the
              selected wallet against the current OFAC SDN list; the local block
              list is separate evidence.
            </p>
            <dl className="d-terms">
              <div>
                <dt>Category</dt>
                <dd>7</dd>
              </div>
              <div>
                <dt>Purpose</dt>
                <dd>1001</dd>
              </div>
              <div>
                <dt>Corridor</dt>
                <dd>
                  {route.fromCountry} → {route.toCountry}
                </dd>
              </div>
              <div>
                <dt>Invoice</dt>
                <dd>Settled in test USDC · {route.currency} estimate above</dd>
              </div>
              <div>
                <dt>Budget</dt>
                <dd>{BUDGET}.00</dd>
              </div>
              <div>
                <dt>Per payment</dt>
                <dd>{PER_PAYMENT}.00</dd>
              </div>
              <div>
                <dt>Last payment</dt>
                <dd>
                  {lastPayment ? (
                    <span className="d-inline-key">
                      <code title={lastPayment}>{shorten(lastPayment)}</code>
                      <CopyButton value={lastPayment} label="last payment" />
                    </span>
                  ) : (
                    "none"
                  )}
                </dd>
              </div>
              {lastClearance ? (
                <div>
                  <dt>Clearance</dt>
                  <dd>
                    Signed for {baseToUsdc(usdcToBase(Number(amount) || 0))}{" "}
                    USDC
                  </dd>
                </div>
              ) : null}
            </dl>
            <div className="d-actions">
              <button
                type="submit"
                className="d-btn d-btn-primary"
                disabled={txOff}
                aria-busy={busy}
              >
                {busy ? <Spinner /> : null}
                Ask for a clearance
              </button>
              <button
                type="button"
                className="d-btn d-btn-secondary"
                onClick={() => run(deliverAndRelease)}
                disabled={
                  txOff ||
                  !funded ||
                  vendor.blocked ||
                  funded.vendor !== vendor.address
                }
                aria-busy={busy}
                aria-describedby={funded ? undefined : "release-hint"}
              >
                {busy ? <Spinner /> : null}
                Deliver and release
                {funded
                  ? ` · ${funded.route.fromCountry} → ${funded.route.toCountry}`
                  : ""}
              </button>
            </div>
            {funded ? null : (
              <p id="release-hint" className="d-hint">
                Deliver and release becomes available after a payment is funded.
              </p>
            )}
          </form>
        </section>

        <section className="d-card d-break" aria-labelledby="attack-title">
          <h2 id="attack-title">Try to break it</h2>
          <div className="d-attacks">
            <article>
              <h3>Test vendor tampering</h3>
              <p id="vendor-test-hint">
                Check that changing the vendor invalidates an existing
                clearance's signature. An invalid signature means protection
                passed. This local test sends no transaction.
              </p>
              <button
                type="button"
                className="d-btn d-btn-secondary"
                onClick={() => run(swapVendor)}
                disabled={busy || !lastClearance}
                aria-busy={busy}
                aria-describedby="vendor-test-hint"
              >
                {busy ? <Spinner /> : null}
                Test signature protection
              </button>
              {!lastClearance ? (
                <p className="d-hint">
                  Request a clearance first to enable this test.
                </p>
              ) : null}
            </article>
            <article>
              <h3>Disable the corridor</h3>
              <p>
                The honest gate refuses. A forced allow can still be signed.
              </p>
              <div className="d-actions">
                <button
                  type="button"
                  className="d-btn d-btn-secondary"
                  onClick={() => run(disableCorridor)}
                  disabled={txOff}
                  aria-busy={busy}
                >
                  {busy ? <Spinner /> : <WarnIcon />}
                  Close the corridor
                </button>
                <button
                  type="button"
                  className="d-btn d-btn-secondary"
                  onClick={() => run(forceAllow)}
                  disabled={txOff}
                  aria-busy={busy}
                >
                  {busy ? <Spinner /> : <WarnIcon />}
                  Force an allow
                </button>
              </div>
            </article>
            <article>
              <h3>Revoke the mandate</h3>
              <p>The next funding fails. Open a new mandate to continue.</p>
              <div className="d-actions">
                <button
                  type="button"
                  className="d-btn d-btn-secondary"
                  onClick={() => run(revoke)}
                  disabled={txOff}
                  aria-busy={busy}
                >
                  {busy ? <Spinner /> : <WarnIcon />}
                  Revoke
                </button>
                <button
                  type="button"
                  className="d-btn d-btn-secondary"
                  onClick={() =>
                    run(() => openMandate(session.current.mandateId + 1))
                  }
                  disabled={txOff}
                  aria-busy={busy}
                >
                  {busy ? <Spinner /> : null}
                  Open the next mandate
                </button>
              </div>
            </article>
          </div>
        </section>

        <aside className="d-card d-evidence" aria-labelledby="log-title">
          <h2 id="log-title">Evidence</h2>
          {busy ? (
            <div className="d-skeleton" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          ) : null}
          {gateDown ? (
            <div className="d-error" role="alert">
              <p>{readable(gateState)}</p>
              <button
                type="button"
                className="d-btn d-btn-secondary"
                onClick={() => run(checkGate)}
                disabled={busy}
              >
                Retry
              </button>
            </div>
          ) : null}
          {log.length === 0 && !busy ? (
            <p className="d-empty">
              Ask for a clearance to see every check, the signed decision and
              the transaction here.
            </p>
          ) : null}
          {banner && banner.tone !== "refused" ? (
            <p
              className={`d-banner d-banner-${banner.tone}`}
              aria-live="polite"
            >
              <Mark
                kind={
                  banner.tone === "cleared"
                    ? "pass"
                    : banner.tone === "review"
                      ? "flag"
                      : "fail"
                }
              />
              <span>{banner.title}</span>
            </p>
          ) : null}
          {reasonCodes.length > 0 ? (
            <ul className="d-chips" aria-label="Reason codes">
              {reasonCodes.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>
          ) : null}
          {log.length > 0 ? (
            <ol className="d-timeline">
              {groupLog(log).map((line, index) => {
                const kind = markFor(line);
                return (
                  <li key={`${line.title}-${line.detail}`}>
                    <Mark kind={kind} />
                    <div>
                      <h3>
                        {line.title}
                        {line.count > 1 ? (
                          <span className="d-count"> × {line.count}</span>
                        ) : null}
                      </h3>
                      <p>{line.detail}</p>
                      {line.signature ? (
                        <p>
                          <a
                            className="d-explorer"
                            href={explorerTx(line.signature)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View on Solana Explorer
                          </a>
                          <CopyButton
                            value={line.signature}
                            label="transaction signature"
                          />
                        </p>
                      ) : null}
                      {index === 0 && callFailed && !gateDown ? (
                        <button
                          type="button"
                          className="d-btn d-btn-secondary"
                          onClick={() => run(retryFailed)}
                          disabled={txOff}
                        >
                          Retry
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : null}
          {lastClearance || lastPayment ? (
            <dl className="d-terms d-clearance">
              {lastClearance ? (
                <div>
                  <dt>Signer</dt>
                  <dd>
                    <span className="d-inline-key">
                      <code title={lastClearance.signer}>
                        {shorten(lastClearance.signer)}
                      </code>
                      <CopyButton
                        value={lastClearance.signer}
                        label="policy signer on the clearance"
                      />
                    </span>
                  </dd>
                </div>
              ) : null}
              {lastClearance ? (
                <div>
                  <dt>Signature</dt>
                  <dd>
                    <span className="d-inline-key">
                      <code title={lastClearance.signature}>
                        {shorten(lastClearance.signature)}
                      </code>
                      <CopyButton
                        value={lastClearance.signature}
                        label="clearance signature"
                      />
                    </span>
                  </dd>
                </div>
              ) : null}
              {lastPayment ? (
                <div>
                  <dt>Last funded payment</dt>
                  <dd>
                    <span className="d-inline-key">
                      <code title={lastPayment}>{shorten(lastPayment)}</code>
                      <CopyButton value={lastPayment} label="payment id" />
                    </span>
                  </dd>
                </div>
              ) : null}
              {funded ? (
                <div>
                  <dt>Amount</dt>
                  <dd>{baseToUsdc(funded.amount)} USDC</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          <p className="d-footnote">
            Leash is not a regulated compliance provider and makes no compliance
            claims. After the gate signs, this page submits the matching devnet
            transaction. The explorer link is that transaction.
          </p>
        </aside>
      </main>
    </div>
  );
}

function skippedLabel(skipped: number[]) {
  if (skipped.length === 0) return "";
  if (skipped.length === 1) return `Mandate ${skipped[0]} was already stored.`;
  const contiguous = skipped.every(
    (id, index) => index === 0 || id === skipped[index - 1] + 1
  );
  const list = contiguous
    ? `${skipped[0]}–${skipped[skipped.length - 1]}`
    : skipped.join(", ");
  return `Mandates ${list} were already stored.`;
}

function groupLog(lines: LogLine[]) {
  const grouped: Array<LogLine & { count: number }> = [];
  for (const line of lines) {
    const existing = grouped.find(
      (item) => item.title === line.title && item.detail === line.detail
    );
    if (existing) existing.count += 1;
    else grouped.push({ ...line, count: 1 });
  }
  return grouped;
}

function shorten(value: string) {
  const trimmed = value.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-5)}`;
}

function readable(detail: string) {
  const first = detail.split("\n")[0] ?? detail;
  return first.replace(/\s+at\s+\S.*/, "").slice(0, 280);
}

function reasonCodesIn(detail: string) {
  return Array.from(new Set(detail.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? []));
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="d-btn d-btn-ghost d-copy"
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      title={value}
      onClick={() => {
        navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {
            setCopied(false);
          });
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function KeyLine({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <p className="d-keyline">
      <span>{label}</span>
      <code title={value}>{shorten(value)}</code>
      <CopyButton value={value} label={label} />
    </p>
  );
}

function Spinner() {
  return (
    <svg className="d-spin" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.35"
      />
      <path
        d="M8 2a6 6 0 0 1 6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg className="d-warn" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 1.5 14.5 13.5h-13L8 1.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path d="M8 6v3.2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="11.2" r="0.7" fill="currentColor" />
    </svg>
  );
}

function Dot({ on }: { on: boolean }) {
  return (
    <span className={on ? "d-dot d-dot-on" : "d-dot"} aria-hidden="true" />
  );
}

function Mark({ kind }: { kind: "pass" | "flag" | "fail" | "info" }) {
  const label =
    kind === "pass"
      ? "Pass"
      : kind === "flag"
        ? "Flag"
        : kind === "fail"
          ? "Blocked"
          : "Note";
  return (
    <span className={`d-mark d-mark-${kind}`}>
      {kind === "pass"
        ? "✓"
        : kind === "fail"
          ? "!"
          : kind === "flag"
            ? "•"
            : "–"}
      <span className="d-mark-label">{label}</span>
    </span>
  );
}

function reasonsOf(result: GateResult): string[] {
  const reasons = result.body.reasons;
  if (Array.isArray(reasons)) return reasons.map(String);
  if (typeof result.body.error === "string") {
    if (
      typeof result.body.message === "string" &&
      result.body.message !== result.body.error
    ) {
      return [`${result.body.error}: ${result.body.message}`];
    }
    return [result.body.error];
  }
  if (typeof result.body.message === "string") return [result.body.message];
  return [];
}

function errorText(result: GateResult): string {
  return reasonsOf(result).join(", ") || `The gate returned ${result.status}.`;
}

function failed(result: GateResult): boolean {
  return result.status >= 400 && errorText(result) !== "BAD_STATE";
}
