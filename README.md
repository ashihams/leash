# vite-anchor

React + Vite starter with Tailwind CSS, `@solana/react-hooks`, and an Anchor vault program example.

## Getting Started

```shell
npx -y create-solana-dapp@latest -t solana-foundation/templates/kit/react-vite-anchor
```

```shell
npm install   # Builds program and generates client automatically
npm run dev
```

Open [http://localhost:5173](http://localhost:5173), connect your wallet, and interact with the vault on devnet.

## What's Included

- **Wallet connection** via `@solana/react-hooks` with auto-discovery
- **SOL Vault program** - deposit and withdraw SOL from a personal PDA vault
- **Codama-generated client** - type-safe program interactions using `@solana/kit`
- **Tailwind CSS v4** with light/dark mode

## Stack

| Layer          | Technology                              |
| -------------- | --------------------------------------- |
| Frontend       | React 19, Vite, TypeScript              |
| Styling        | Tailwind CSS v4                         |
| Solana Client  | `@solana/client`, `@solana/react-hooks` |
| Program Client | Codama-generated, `@solana/kit`         |
| Program        | Anchor (Rust)                           |

## Project Structure

```
├── src/
│   ├── App.tsx               # Main app with wallet UI
│   ├── VaultCard.tsx         # Vault deposit/withdraw UI
│   ├── providers.tsx         # Solana client setup
│   ├── generated/vault/      # Codama-generated program client
│   └── main.tsx              # Entry point
├── anchor/                   # Anchor workspace
│   └── programs/vault/       # Vault program (Rust)
└── codama.json               # Codama client generation config
```

## Deploy Your Own Vault

The included vault program is already deployed to devnet. To deploy your own:

> **Note:** `npm run setup` and `npm run anchor-build` pass `--ignore-keys` to `anchor build` so the program keeps the devnet program ID shipped with this template (`F4jZpgbtTb6RWNWq6v35fUeiAsRJMrDczVPv9U23yXjB`). Anchor 1.x otherwise generates a fresh program keypair on build and rewrites `declare_id!`. The steps below build without that flag on purpose, so Anchor syncs your own program ID before deploying.

### Prerequisites

- [Rust](https://rustup.rs/)
- [Solana CLI](https://solana.com/docs/intro/installation)
- [Anchor](https://www.anchor-lang.com/docs/installation)

### Steps

1. **Configure Solana CLI for devnet**

   ```bash
   solana config set --url devnet
   ```

2. **Create a wallet (if needed) and fund it**

   ```bash
   solana-keygen new
   solana airdrop 2
   ```

3. **Build and deploy the program**

   ```bash
   cd anchor
   anchor build
   anchor keys sync    # Updates program ID in source
   anchor build        # Rebuild with new ID
   anchor deploy
   cd ..
   ```

4. **Regenerate the client and restart**
   ```bash
   npm run setup   # Rebuilds program and regenerates client
   npm run dev
   ```

## Testing

Tests use [LiteSVM](https://github.com/LiteSVM/litesvm), a fast lightweight Solana VM for testing.

```bash
npm run anchor-build   # Build the program first
npm run anchor-test    # Run tests
```

The tests are in `anchor/programs/vault/src/tests.rs` and automatically use the program ID from `declare_id!`.

## Regenerating the Client

If you modify the program, regenerate the TypeScript client:

```bash
npm run setup   # Or: npm run anchor-build && npm run codama:js
```

This uses [Codama](https://github.com/codama-idl/codama) to generate a type-safe client from the Anchor IDL.

## Supabase history backend

Solana stays the source of truth for money, mandates, and escrow. Supabase stores dashboard login, linked wallets, payment history, clearances, check results, the review queue, and the audit log. A row in Supabase does not authorize a payment.

### Setup

1. Create a Supabase project and apply `supabase/migrations/20261107143000_leash_history.sql` in the SQL editor.
2. For Solana dashboard sign-in, enable Authentication, Providers, Web3. Email magic link and email plus password work without that provider.
3. Copy `.env.example` to `.env`. Fill in `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_KEY`. Add `INTERNAL_API_SECRET` and a 32-byte base64 `WALLET_AUTH_SECRET`.
4. Copy the same URL and anon key to `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Do not create a `VITE_` variable for the service key.
5. Start the gate with `npm run server` and the dashboard with `npm run dev`.
6. Seed demo vendors and one user per role with `npm run seed`. The script writes stable public keys under `keys/`, which is gitignored.

`npm run history:test` runs the auth, review, and row-security tests.

### Assumptions

- The existing Fastify gate on port 8787 still decides clearances. When the Supabase variables above are all set, a signed clearance is stored in Supabase before it is returned. If that write fails, the gate returns `CHECK_UNAVAILABLE` and does not hand the signature to the caller. With Supabase unset, the gate keeps using SQLite only.
- Wallet challenge messages are the UTF-8 lines from `server/src/lib/messages.ts`. A nonce lasts 60 seconds. The wallet token lasts 15 minutes. A review with no decision for 15 minutes becomes `timed_out`, which the gate should treat as deny.
- Vendor history outcomes use these demo thresholds: 5 or more payments in 15 minutes denies for velocity; a refund or dispute ratio above 0.2 denies once there are at least 5 payments; a wallet on `screening_list` denies. The label on that list is mock data.
- A new Supabase user is an auditor. Changing `profiles.role` is a service-role or database-owner action. Sign in with Solana creates a dashboard session through Supabase Web3. It does not create the payment-party wallet token. Linking a wallet still requires dashboard login plus `POST /auth/link-wallet`.
- The policy engine calls `POST /internal/check-results`, `POST /internal/clearances`, and `POST /internal/reviews` with the `X-Internal-Secret` header. Reviewers decide with a signature over the payment id, decision, and a `review` nonce.
- Demo credentials and the screening list are mock. They are not KYC, AML, sanctions, or Travel Rule checks.

### Security notes

- The service key is server-only. It is read from `SUPABASE_SERVICE_KEY` and is never passed to `createClient` in frontend code.
- Roles live in the `profiles` table. The server loads the role after `supabase.auth.getUser(token)`. A role sent by the browser is ignored. The new-user trigger always inserts `auditor` and does not copy a role out of user metadata.
- Wallet auth is separate from dashboard login. A Solana signature proves control of a wallet for one purpose. It does not make that wallet the owner of the treasury.
- Solana remains the source of truth. Supabase history cannot move USDC, change a mandate, or override an on-chain refusal.
- `audit_log` has no update or delete policy. A trigger rejects those writes for every role except the database owner. Client insert and update on `payment_history`, `clearances`, and `audit_log` are not granted.
- Database and signature failures return an error code. Callers, including the policy engine, treat that as deny. They do not turn an error into a pass.

## Learn More

- [Solana Docs](https://solana.com/docs) - core concepts and guides
- [Anchor Docs](https://www.anchor-lang.com/docs) - program development framework
- [Deploying Programs](https://solana.com/docs/programs/deploying) - deployment guide
- [framework-kit](https://github.com/solana-foundation/framework-kit) - the React hooks used here
- [Codama](https://github.com/codama-idl/codama) - client generation from IDL
