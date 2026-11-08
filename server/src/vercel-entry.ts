import { createClient } from "@supabase/supabase-js";
import nacl from "tweetnacl";
import { buildApp } from "./app.ts";
import { supabaseGateStore } from "./gate-store.ts";
import { assertProviderConfig } from "./providers/config.ts";
import { DiditIdentity } from "./providers/identity.ts";
import { OfacSdnProvider, createSupabaseOfacStore } from "./providers/ofac.ts";
import { supabaseProviderStore } from "./providers/store.ts";
import { SupabaseRepository } from "./lib/supabase-repository.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";

function keyFromEnv(name: string) {
  const secret = process.env[name];
  if (!secret) throw new Error(`Missing ${name}`);
  return nacl.sign.keyPair.fromSecretKey(
    Uint8Array.from(Buffer.from(secret, "base64"))
  );
}

let app: ReturnType<typeof buildApp> | undefined;

export function gateApp() {
  if (app) return app;
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const mint = process.env.LEASH_USDC_MINT;
  if (!url || !serviceKey || !mint) {
    throw new Error("Missing Supabase gate configuration");
  }
  const policy = keyFromEnv("LEASH_POLICY_SECRET");
  const verifier = keyFromEnv("LEASH_VERIFIER_SECRET");
  const config = assertProviderConfig(process.env);
  const client = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
  const repository = new SupabaseRepository(client);
  const ofac = new OfacSdnProvider();
  let refreshing: Promise<void> | undefined;
  const fresh = () =>
    (refreshing ??= ofac
      .ensureFresh({
        store: createSupabaseOfacStore(client),
        cachePath: join(tmpdir(), "leash-ofac-index.json"),
        expectedSha256: process.env.OFAC_SDN_SHA256 ?? null,
      })
      .finally(() => {
        refreshing = undefined;
      }));
  app = buildApp({
    store: supabaseGateStore(client),
    providerRoutes: {
      store: supabaseProviderStore(client),
      sanctions: {
        async screenWallet(wallet) {
          await fresh();
          return ofac.screenWallet(wallet);
        },
        async health() {
          await fresh();
          return ofac.health();
        },
      },
      identity: new DiditIdentity(
        config.diditKey,
        config.diditWorkflowId,
        config.diditWebhookSecret
      ),
      environment:
        process.env.DIDIT_ENVIRONMENT === "sandbox" ? "sandbox" : "live",
      getDashboardUser: async (token) => {
        const { data, error } = await client.auth.getUser(token);
        return error || !data.user
          ? null
          : { id: data.user.id, email: data.user.email ?? "" };
      },
      getProfile: (id) => repository.getProfile(id),
    },
    policy,
    verifier: verifier.publicKey,
    mint,
    policyVersion: Number(process.env.LEASH_POLICY_VERSION ?? "1"),
  });
  return app;
}

export async function handleGate(
  method: string,
  url: string,
  body: Buffer,
  contentType: string
) {
  const application = gateApp();
  await application.ready();
  const result = await application.inject({
    method: method as "GET",
    url,
    headers: contentType ? { "content-type": contentType } : {},
    payload: body.length > 0 ? body : undefined,
  });
  return {
    status: result.statusCode,
    contentType: String(result.headers["content-type"] ?? "application/json"),
    body: result.body,
  };
}
