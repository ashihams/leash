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
6. Seed demo vendor wallets, payment history, and one login per role with `npm run seed`. The script does not write screening rows or identity credentials. It writes stable public keys under `keys/`, which is gitignored. Link a wallet from the dashboard after signing in.

`npm run history:test` runs the auth, review, and row-security tests.

### Assumptions

- The existing Fastify gate on port 8787 still decides clearances. When the Supabase variables above are all set, a signed clearance is stored in Supabase before it is returned. If that write fails, the gate returns `CHECK_UNAVAILABLE` and does not hand the signature to the caller. With Supabase unset, the gate keeps using SQLite only.
- Wallet challenge messages are the UTF-8 lines from `server/src/lib/messages.ts`. A nonce lasts 60 seconds. The wallet token lasts 15 minutes. A review with no decision for 15 minutes becomes `timed_out`, which the gate should treat as deny.
- Vendor history outcomes use these demo thresholds: 5 or more payments in 15 minutes denies for velocity; a refund or dispute ratio above 0.2 denies once there are at least 5 payments. The history unit fixture can still mark a wallet as screened. The seed script does not.
- A new Supabase user is an auditor. Changing `profiles.role` is a service-role or database-owner action. Sign in with Solana creates a dashboard session through Supabase Web3. It does not create the payment-party wallet token. Linking a wallet still requires dashboard login plus `POST /auth/link-wallet`.
- The policy engine calls `POST /internal/check-results`, `POST /internal/clearances`, and `POST /internal/reviews` with the `X-Internal-Secret` header. Reviewers decide with a signature over the payment id, decision, and a `review` nonce.
- The seed script writes vendor wallets and payment history. It does not write screening rows or identity credentials.

### Security notes

- The service key is server-only. It is read from `SUPABASE_SERVICE_KEY` and is never passed to `createClient` in frontend code.
- Roles live in the `profiles` table. The server loads the role after `supabase.auth.getUser(token)`. A role sent by the browser is ignored. The new-user trigger always inserts `auditor` and does not copy a role out of user metadata.
- Wallet auth is separate from dashboard login. A Solana signature proves control of a wallet for one purpose. It does not make that wallet the owner of the treasury.
- Solana remains the source of truth. Supabase history cannot move USDC, change a mandate, or override an on-chain refusal.
- `audit_log` has no update or delete policy. A trigger rejects those writes for every role except the database owner. Client insert and update on `payment_history`, `clearances`, and `audit_log` are not granted.
- Database and signature failures return an error code. Callers, including the policy engine, treat that as deny. They do not turn an error into a pass.

## What is real, what is not claimed

Leash is not a regulated compliance provider and makes no compliance claims.

Wallet screening uses the OFAC SDN Advanced XML export. It is a public file and needs no API key. A no-match evidence record says: "No match on the OFAC SDN list (US Treasury), retrieved <date>, sha256 <hash>. OFAC states its digital currency address listings are not exhaustive. EU, UN and other lists are not covered."

Didit identity sessions stay server-side. `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID`, and `DIDIT_WEBHOOK_SECRET` are required or the gate refuses to start. Sessions are created at `POST https://verification.didit.me/v3/session/` with `vendor_data` set to the vendor wallet.

Pages read before writing this client:

- [OFAC SDN Advanced XML](https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_ADVANCED.XML)
- [OFAC advanced XML schema](https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ADVANCED_XML.xsd)
- [OFAC advanced sanctions list FAQ](https://ofac.treasury.gov/sdn-list-data-formats-data-schemas/frequently-asked-questions-on-advanced-sanctions-list-standard)
- [OFAC FAQ 562](https://ofac.treasury.gov/faqs/562)
- [OFAC FAQ 563](https://ofac.treasury.gov/faqs/563)
- [OFAC FAQ 594](https://ofac.treasury.gov/faqs/594)
- [OFAC hash values](https://ofac.treasury.gov/specially-designated-nationals-list-sdn-list/hash-values-for-ofac-sanctions-list-files)
- [Didit create session](https://docs.didit.me/sessions-api/create-session)
- [Didit sessions overview](https://docs.didit.me/sessions-api/overview)
- [Didit API flow](https://docs.didit.me/integration/api-full-flow)
- [Didit webhooks](https://docs.didit.me/integration/webhooks)
- [Didit webhook destination](https://docs.didit.me/management-api/webhook/create-destination)
- [Didit verification statuses](https://docs.didit.me/integration/verification-statuses)
- [Didit sandbox testing](https://docs.didit.me/integration/sandbox-testing)
- [Range sanctions check](https://docs.range.org/risk-api/risk/get-sanctions-blacklist-check)
- [Range Risk API quick start](https://docs.range.org/risk-api/quickstart)

What those pages actually state:

- FAQ 562: OFAC's digital currency address listings are not likely to be exhaustive.
- FAQ 563: a digital currency field begins with "Digital Currency Address", then a dash and the symbol, then the address. The schema stores that field as `FeatureType` text and the address as `VersionDetail` text.
- FAQ 594: the Sanctions List Search ID field returns only exact matches for a digital currency address.
- The hash-values page lists SHA-256 for the human-readable PDF lists. It says Sanctions List Service file signatures are shown beside each SLS file. The SDN Advanced XML response itself sends a `Digest: sha-256...` header. Refresh compares the downloaded bytes with that header, and with `OFAC_SDN_SHA256` when that variable is set. A mismatch fails the refresh.
- Didit create-session: $10 of free credit per month. Sandbox: 500 session creates per 24 hours, and sandbox sessions are not billed.
- Range's sanctions page documents `GET /v1/risk/sanctions/{address}`. `lists_checked: false` or `is_sanctioned: null` is an unknown result. The OpenAPI security scheme names the header `X-API-KEY`. The curl examples on the same page use `Authorization: Bearer`. This client sends `X-API-KEY`. The page documents HTTP 429 when the rate limit is exceeded. It does not publish a trial quota number.

The list is refreshed on startup when the loaded version is older than 24 hours, and again every 24 hours. A missing list, an empty address index, or a list older than 72 hours returns `CHECK_UNAVAILABLE` / `LIST_STALE` and the gate does not sign an allow. A Solana address on the list fails with `LIST_MATCH_WALLET`. Apply `supabase/migrations/20261107223000_ofac_sdn.sql` before storing versions. `npm run ofac:refresh` downloads and stores the index. `npm run ofac:coverage` prints address counts per currency symbol, including SOL. `npm run providers:verify` prints Didit session URLs. `npm run providers:warm` screens the demo wallets against the loaded list.

Range is optional. It stays off unless `RANGE_API_KEY` is set, and the clearance path does not call it.

### Assumptions

- Digital currency addresses are `Feature` / `VersionDetail` values whose `FeatureType` text starts with `Digital Currency Address - `. Every symbol is indexed. The symbol is the text after that prefix.
- Program names come from `SanctionsProgram`, linked by `LegalBasis` `@SanctionsProgramID` and `EntryEvent` `@LegalBasisID`. The entry id is `SanctionsEntry` `@ID`. Several entry ids on one profile are stored joined, in sorted order.
- `LegalBasisValues` appears before `SanctionsProgramValues` in the schema, so the program name is resolved when the entry is read, not when the legal basis is read.
- Base58 addresses are matched exactly. An address that matches `0x` plus hex is stored in lowercase. `screenWallet` accepts only a 32-byte base58 Solana public key. Anything else is `PARAMS_INVALID`.
- The `Digest` header on the SDN Advanced XML response is the official hash compared for that download. The PDF hash page does not publish a hash for this XML file.
- The SDN file is large, so its download uses a 120 second timeout and one retry. The 3 second helper remains for Didit and Range.
- A parsed public index is also written to `server/data/ofac-index.json`, which is gitignored. Supabase stores the version row and the address rows when the service key is set. Names are not stored.
- Rows with `DeltaAction="delete"` are skipped.
- An empty digital-currency extract is refused and does not replace a previously loaded list. A hash mismatch does not replace it either.
- The clearance is still 288 bytes and has only allow or deny. A `flag` is stored on the check row, and the signed clearance is deny.
- Didit statuses `Approved`, `In Review`, `Declined`, and `Kyc Expired` map to pass, flag `REVIEW_STARTED`, `VENDOR_CREDENTIAL_INVALID`, and `VENDOR_CREDENTIAL_EXPIRED`. `In Review` is inserted into `review_queue` when Supabase history is configured. Any other session status is flag `SESSION_OPEN`. A missing identity row is `VENDOR_NOT_REGISTERED`.
- Webhooks are checked with `X-Signature` over the raw body and `X-Timestamp` within 300 seconds, using `timingSafeEqual`. Didit's newer `X-Signature-V2` canonical-JSON signature is not the one this server checks.
- The same webhook event id is rejected as `REPLAYED`. A later event id for the same session can update the status. The same session id and the same status does not write a second identity change.
- Stored identity data is the wallet, session id, status, and expiry. Names, document numbers, dates of birth, document images, and raw webhook bodies are not stored or logged.
- `server/test/gate.test.ts` does not attach the provider gate, so those allow signatures stay local. `server/src/index.ts` always attaches the OFAC screener and exits if the Didit config is missing.
- Identity rows are written to the gate SQLite database and can be mirrored to Supabase `audit_log` when history is configured.
- The Didit host is the documented `https://verification.didit.me`. It is not a separate environment variable.
- Every Range result, including an unavailable one, is cached for the life of the process so a small quota is not spent twice on the same address.

## Learn More

- [Solana Docs](https://solana.com/docs) - core concepts and guides
- [Anchor Docs](https://www.anchor-lang.com/docs) - program development framework
- [Deploying Programs](https://solana.com/docs/programs/deploying) - deployment guide
- [framework-kit](https://github.com/solana-foundation/framework-kit) - the React hooks used here
- [Codama](https://github.com/codama-idl/codama) - client generation from IDL
