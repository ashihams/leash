import { createClient } from "@supabase/supabase-js";
import nacl from "tweetnacl";
import { buildApp } from "./app.ts";
import { supabaseGateStore } from "./gate-store.ts";

function keyFromEnv(name: string) {
  const secret = process.env[name];
  if (!secret) throw new Error(`Missing ${name}`);
  return nacl.sign.keyPair.fromSecretKey(
    Uint8Array.from(Buffer.from(secret, "base64")),
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
  app = buildApp({
    store: supabaseGateStore(
      createClient(url, serviceKey, { auth: { persistSession: false } }),
    ),
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
  contentType: string,
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
