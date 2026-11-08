# Payment integration check — 2026-11-08

## Completed initialization

After explicit user approval, all four route initialization transactions were simulated, sent, and confirmed on devnet. The live local frontend endpoint `http://127.0.0.1:5173/gate/health/chain` now reports `ready: true`, `configurationReady: true`, no configuration mismatches, and all four routes ready with matching backend/on-chain limits. No payment or USDC transfer was performed.

| Route   | Confirmed transaction                                                                                                                                      |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| US → IN | [View transaction](https://explorer.solana.com/tx/3sm9a4TtzND6CdRoavUKKoTR4RAo8AeYFJWFBGVa4iVEHsGb3TBpAY6vB81jaJ6wTzMUEWMa2adep4C5F7x4i7tc?cluster=devnet) |
| US → GB | [View transaction](https://explorer.solana.com/tx/34c7657TDHfpox8T53Ko5q3CvUgnWX6i5BUGk4vp5sm4qHE8cqFTrsX8qmeueeSjke4HZ9x1cu8as38A3pFZfjas?cluster=devnet) |
| US → DE | [View transaction](https://explorer.solana.com/tx/2BzqJFE4YGEQbWo2WN6TsgZYE1cXXrUwVoiNAerxYtxSyXkeSYdBJwX6LxQXiA3vkGV2Qe4mMGtZEHX94DqxT2Ne?cluster=devnet) |
| US → PH | [View transaction](https://explorer.solana.com/tx/2gZuxNU9pEBFtU5rzjx5LGqXiyNVVCciLDVjsWuQbVDYEEm1b9TJHtNSmFcDAyb2iFvVULGeoL7vbixwJ9Q8L2MG?cluster=devnet) |

The frontend and backend were restarted locally before initialization. The frontend HTML, current Dashboard module, both API proxy prefixes, and chain readiness endpoint responded successfully. The investigation below records the initial state and transaction review before approval.

## Initial investigation

The local backend at `http://127.0.0.1:8787` responds successfully. Its mint, policy signer, verifier, and policy version match the deployed devnet configuration. The wallet provider, instruction builder, and backend readiness reader now share the same program ID and RPC endpoint.

The database automatically seeds four cross-border routes. That does not initialize their Solana accounts. All four on-chain accounts were missing during this check. This is why the dashboard stops before requesting a wallet signature.

The deployed binary differs from `anchor/target/deploy/leash.so`. An unsigned simulation of the frontend's current `create_mandate` instruction succeeds against the deployed program. This verifies that instruction, not the entire deployed binary or a completed payment. No upgrade was performed.

## Changes and validation

- `/health/chain` checks the deployed program, config account, backend signer/mint/policy agreement, and each route's account and limits. RPC failures are reported separately from missing accounts.
- The dashboard checks readiness when selecting a route and before mandate setup, and displays the reason before a wallet prompt.
- Fresh bootstrap initializes the four dashboard routes instead of only US → US. Existing deployments use the separate route-seeding script.
- `node scripts/devnet-status.mjs --simulate` reports all routes and binary differences and simulates the frontend mandate instruction without signing.
- 42 Vitest tests and 5 backend tests passed. Production frontend build, backend bundle, and lint passed (three existing React fast-refresh warnings).

The running local backend must be restarted to load the new endpoint. The frontend URL was not supplied, so the user's browser-to-hosted-backend connection has not been verified. A request to local port 5173 did not connect. These code changes have not been published.

## Prepared route initialization

All four unsigned initialization simulations passed. No transaction was signed or sent.

- Cluster: Solana devnet
- Program: `8Eq2Ug3URR5ugzDfjYk4bbkBJa8o7U6YZtPp6vLDHezd`
- Admin and fee payer: `8ZBVLivQLgxqUpxV9z8nLWJZwpvZsXqgMmXJkAUavwrU`
- Instruction: `init_corridor`, one transaction per missing route
- Settings per route: enabled; 1 test USDC per-payment cap; 10,000 test USDC daily cap; packet threshold 0
- Rent per new account: 924,560 lamports
- Estimated fee per transaction: 5,000 lamports
- Estimated total: 3,718,240 lamports (0.00371824 devnet SOL); no USDC transfer

| Route   | Account receiving rent                         |
| ------- | ---------------------------------------------- |
| US → IN | `3sjTGmSF2enuPFN72YqsmwRbAKihfokcjCSvndgMgY4D` |
| US → GB | `AsPTE2q2wtCYED3ipervJohnmvDedgwHxrxjy8AgsFNX` |
| US → DE | `7SKdytKR7b3J2R6kepeajn38AxJw7R5nUqRwmtuEHF1d` |
| US → PH | `Ek885zsgB2WYSFWYTMGuZh1tpPyo5Pctai7FAwZXoypk` |

After explicit approval, `node scripts/seed-corridors.mjs --send` rechecks and simulates missing routes before signing, sending, and confirming them. Existing valid routes are skipped. Run the integration report afterward and verify readiness through the actual frontend URL before testing a payment.
