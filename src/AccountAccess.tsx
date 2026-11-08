import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";
import { describeWalletError } from "./leash/wallet";

type Notice = { title: string; detail: string };

export function AccountAccess() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sessionEmail, setSessionEmail] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (alive)
        setSessionEmail(
          data.session?.user.email ?? (data.session ? "Solana account" : "")
        );
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setSessionEmail(session?.user.email ?? (session ? "Solana account" : ""));
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
        {sessionEmail ? `Signed in as ${sessionEmail}` : "Sign in to continue."}
      </p>
      {notice ? (
        <p role="status">
          {notice.title}. {notice.detail}
        </p>
      ) : null}
      {!sessionEmail ? (
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
            <button
              className="d-btn d-btn-primary"
              type="submit"
              disabled={busy}
              aria-busy={busy}
            >
              Sign in
            </button>
          </div>
        </form>
      ) : null}
      {sessionEmail ? (
        <div className="d-actions">
          <button
            className="d-btn d-btn-ghost"
            type="button"
            disabled={busy}
            aria-busy={busy}
            onClick={() =>
              run(async () => {
                await client.auth.signOut();
                setNotice({
                  title: "Signed out",
                  detail: "The dashboard session is closed.",
                });
              })
            }
          >
            Sign out
          </button>
        </div>
      ) : null}
    </section>
  );
}
