import { useEffect, useState } from "react";
import type { WalletSession } from "@solana/client";
import bs58 from "bs58";
import { supabase } from "./lib/supabase";
import { describeWalletError, withWalletTimeout } from "./leash/wallet";

const GATE = import.meta.env.VITE_GATE_URL ?? "/gate";
const SIGN_IN_STATEMENT = "Sign in to Leash. This does not move funds or approve a payment.";

type Notice = { title: string; detail: string };

export function AccountAccess({ wallet }: { wallet?: WalletSession }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sessionEmail, setSessionEmail] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (alive) setSessionEmail(data.session?.user.email ?? "");
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setSessionEmail(session?.user.email ?? "");
    });
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, []);

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await work();
    } catch (error) {
      setNotice({
        title: "Account",
        detail: describeWalletError(error),
      });
    } finally {
      setBusy(false);
    }
  }

  async function signInWithSolana() {
    if (!supabase) return;
    if (!wallet?.signMessage) {
      setNotice({
        title: "Wallet",
        detail: "Connect Phantom before signing a message. The demo owner key does not sign in.",
      });
      return;
    }
    const address = wallet.account.address.toString();
    const { error } = await supabase.auth.signInWithWeb3({
      chain: "solana",
      statement: SIGN_IN_STATEMENT,
      wallet: {
        publicKey: { toBase58: () => address },
        signMessage: (message) => {
          if (!wallet.signMessage) return Promise.reject(new Error("Connect Phantom before signing a message."));
          return withWalletTimeout(wallet.signMessage(message));
        },
      },
    });
    if (error) {
      setNotice({ title: "Sign in", detail: error.message });
      return;
    }
    setNotice({
      title: "Signed in",
      detail: "Supabase accepted the Solana signature. The profile role still comes from the database.",
    });
  }

  async function linkWallet() {
    if (!supabase || !wallet?.signMessage) {
      setNotice({
        title: "Wallet",
        detail: "Sign in, then connect Phantom.",
      });
      return;
    }
    const session = (await supabase.auth.getSession()).data.session;
    if (!session) {
      setNotice({
        title: "Account",
        detail: "Dashboard login is required before a wallet can be linked.",
      });
      return;
    }
    const address = wallet.account.address.toString();
    const challenge = await gate("/auth/challenge", {
      wallet: address,
      purpose: "link_wallet",
    });
    if (!challenge.ok) {
      setNotice({ title: "Challenge", detail: challenge.error });
      return;
    }
    const signature = await withWalletTimeout(
      wallet.signMessage(new TextEncoder().encode(challenge.message)),
    );
    const verified = await gate("/auth/verify", {
      wallet: address,
      nonce: challenge.nonce,
      signature: bs58.encode(signature),
    });
    if (!verified.ok) {
      setNotice({ title: "Verify", detail: verified.error });
      return;
    }
    const linked = await gate(
      "/auth/link-wallet",
      { walletToken: verified.token, kind: "owner" },
      session.access_token,
    );
    setNotice({
      title: linked.ok ? "Wallet linked" : "Link",
      detail: linked.ok
        ? `${address} is linked to this login. It still cannot spend the treasury.`
        : linked.error,
    });
  }

  if (!supabase) {
    return (
      <section className="d-account" aria-labelledby="account-title">
        <p className="d-section-title" id="account-title">
          Account
        </p>
        <p>
          Supabase is not configured. Set VITE_SUPABASE_URL and
          VITE_SUPABASE_ANON_KEY to turn on dashboard login. The service key
          stays on the server.
        </p>
      </section>
    );
  }
  const client = supabase;

  return (
    <section className="d-account" aria-labelledby="account-title">
      <p className="d-section-title" id="account-title">
        Account
      </p>
      <p role="status">
        {sessionEmail
          ? `Signed in as ${sessionEmail}`
          : "Not signed in. Email login and the Solana signature are separate from the payment gate."}
      </p>
      {notice ? (
        <p role="status">
          {notice.title}. {notice.detail}
        </p>
      ) : null}
      <form
        className="d-form"
        onSubmit={(event) => {
          event.preventDefault();
          run(async () => {
            const { error } = await client.auth.signInWithPassword({
              email,
              password,
            });
            if (error) {
              setNotice({ title: "Sign in", detail: error.message });
              return;
            }
            setPassword("");
            setNotice({ title: "Signed in", detail: email });
          });
        }}
      >
        <label>
          Email
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <div className="d-actions">
          <button className="d-btn d-btn-primary" type="submit" disabled={busy} aria-busy={busy}>
            Sign in
          </button>
          <button
            className="d-btn d-btn-secondary"
            type="button"
            disabled={busy}
            aria-busy={busy}
            onClick={() =>
              run(async () => {
                const { error } = await client.auth.signUp({ email, password });
                if (error) {
                  setNotice({ title: "Create account", detail: error.message });
                  return;
                }
                setPassword("");
                setNotice({
                  title: "Account created",
                  detail: "The new profile is an auditor until a service-role change.",
                });
              })
            }
          >
            Create account
          </button>
          <button
            className="d-btn d-btn-secondary"
            type="button"
            disabled={busy || !email}
            aria-busy={busy}
            onClick={() =>
              run(async () => {
                const { error } = await client.auth.signInWithOtp({ email });
                if (error) {
                  setNotice({ title: "Magic link", detail: error.message });
                  return;
                }
                setNotice({
                  title: "Magic link",
                  detail: "Check the inbox for this email.",
                });
              })
            }
          >
            Email a magic link
          </button>
        </div>
      </form>
      <div className="d-actions">
        <button
          className="d-btn d-btn-secondary"
          type="button"
          disabled={busy}
          aria-busy={busy}
          onClick={() => run(signInWithSolana)}
        >
          Sign in with Solana
        </button>
        <button
          className="d-btn d-btn-secondary"
          type="button"
          disabled={busy}
          aria-busy={busy}
          onClick={() => run(linkWallet)}
        >
          Link this wallet
        </button>
        {sessionEmail ? (
          <button
            className="d-btn d-btn-ghost"
            type="button"
            disabled={busy}
            aria-busy={busy}
            onClick={() =>
              run(async () => {
                await client.auth.signOut();
                setNotice({ title: "Signed out", detail: "The dashboard session is closed." });
              })
            }
          >
            Sign out
          </button>
        ) : null}
      </div>
    </section>
  );
}

type GateOk = {
  ok: true;
  message: string;
  nonce: string;
  token: string;
};

type GateResult = GateOk | { ok: false; error: string };

async function gate(
  path: string,
  body: unknown,
  accessToken?: string,
): Promise<GateResult> {
  const response = await fetch(`${GATE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  let payload: { error?: string; message?: string; nonce?: string; token?: string } =
    {};
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    return { ok: false, error: "The history service did not return JSON." };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: payload.error ?? "The history service refused the request.",
    };
  }
  return {
    ok: true,
    message: payload.message ?? "",
    nonce: payload.nonce ?? "",
    token: payload.token ?? "",
  };
}
