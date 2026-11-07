import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { once } from "node:events";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import type { SupabaseClient } from "@supabase/supabase-js";
import bs58 from "bs58";
import type { ScreenResult, SanctionsScreeningProvider } from "./types.ts";

const require = createRequire(import.meta.url);
const sax = require("sax") as {
  createStream: (
    strict: boolean,
    options: { trim: boolean; xmlns: boolean },
  ) => NodeJS.WritableStream & {
    on(event: "opentag", listener: (tag: SaxTag) => void): unknown;
    on(event: "text" | "cdata", listener: (text: string) => void): unknown;
    on(event: "closetag", listener: (name: string) => void): unknown;
    on(event: "end", listener: () => void): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
  };
};

type SaxTag = {
  name: string;
  attributes: Record<string, string>;
};

export const OFAC_SOURCE_URL =
  "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_ADVANCED.XML";
export const OFAC_NAMESPACE =
  "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ADVANCED_XML";
const ADDRESS_PREFIX = "Digital Currency Address - ";
const FRESH_MS = 24 * 60 * 60 * 1000;
const STALE_MS = 72 * 60 * 60 * 1000;
const CACHE_PATH = fileURLToPath(
  new URL("../../data/ofac-index.json", import.meta.url),
);

export type OfacAddress = {
  address: string;
  currencySymbol: string;
  sdnEntryId: string;
  programs: string[];
};

export type OfacSnapshot = {
  id: string;
  retrievedAt: string;
  sourceUrl: string;
  sha256: string;
  addressCount: number;
  solAddressCount: number;
  counts: Record<string, number>;
  addresses: OfacAddress[];
};

export class OfacScreenError extends Error {
  code: "PARAMS_INVALID" | "LIST_STALE" | "CHECK_UNAVAILABLE" | "HASH_MISMATCH" | "EMPTY_LIST";

  constructor(code: OfacScreenError["code"]) {
    super(code);
    this.code = code;
  }
}

type Hit = { currency: string; sdnEntryId: string; programs: string[] };

export function ofacNoMatchStatement(retrievedAt: string, sha256: string): string {
  const date = retrievedAt.slice(0, 10);
  return `No match on the OFAC SDN list (US Treasury), retrieved ${date}, sha256 ${sha256}. OFAC states its digital currency address listings are not exhaustive. EU, UN and other lists are not covered.`;
}

export function officialSha256FromDigest(header: string | null): string | null {
  if (!header) return null;
  const hex = header.match(/sha-256(?:=|:)?([0-9a-fA-F]{64})/i);
  if (hex) return hex[1].toLowerCase();
  const encoded = header.match(/sha-256=([A-Za-z0-9+/]+=*)/);
  if (!encoded) return null;
  const bytes = Buffer.from(encoded[1], "base64");
  return bytes.length === 32 ? bytes.toString("hex") : null;
}

export function isSolanaPubkey(wallet: string): boolean {
  if (wallet.startsWith("0x")) return false;
  try {
    return bs58.decode(wallet).length === 32;
  } catch {
    return false;
  }
}

export function normalizeListedAddress(address: string): string {
  const value = address.trim();
  if (/^0x[0-9a-fA-F]+$/.test(value)) return value.toLowerCase();
  return value;
}

export function countByCurrency(addresses: OfacAddress[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of addresses) {
    counts[row.currencySymbol] = (counts[row.currencySymbol] ?? 0) + 1;
  }
  return counts;
}

export function versionsToDrop(idsNewestFirst: string[], keep = 3): string[] {
  return idsNewestFirst.slice(keep);
}

export class OfacSdnProvider implements SanctionsScreeningProvider {
  private readonly hits = new Map<string, Hit>();
  private meta: OfacSnapshot | null = null;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  load(snapshot: OfacSnapshot): void {
    if (snapshot.addresses.length === 0) throw new OfacScreenError("EMPTY_LIST");
    this.hits.clear();
    for (const row of snapshot.addresses) {
      const current = this.hits.get(row.address);
      const next: Hit = {
        currency: row.currencySymbol,
        sdnEntryId: row.sdnEntryId,
        programs: row.programs,
      };
      if (!current || row.currencySymbol === "SOL") this.hits.set(row.address, next);
    }
    this.meta = snapshot;
  }

  remember(path = CACHE_PATH): void {
    if (this.meta) this.writeCache(path, this.meta);
  }

  async health(): Promise<boolean> {
    return this.usable();
  }

  async screenWallet(wallet: string): Promise<ScreenResult> {
    if (!isSolanaPubkey(wallet)) throw new OfacScreenError("PARAMS_INVALID");
    if (!this.meta || this.hits.size === 0) {
      throw new OfacScreenError("CHECK_UNAVAILABLE");
    }
    if (this.now() - Date.parse(this.meta.retrievedAt) > STALE_MS) {
      throw new OfacScreenError("LIST_STALE");
    }
    const hit = this.hits.get(wallet);
    if (hit) {
      return {
        listed: true,
        supported: true,
        providerRef: hit.sdnEntryId,
        raw: {
          sdn_entry_id: hit.sdnEntryId,
          currency: hit.currency,
          sha256: this.meta.sha256,
        },
      };
    }
    return {
      listed: false,
      supported: true,
      raw: {
        source: "OFAC SDN",
        listVersion: this.meta.id,
        retrieved_at: this.meta.retrievedAt,
        sha256: this.meta.sha256,
        statement: ofacNoMatchStatement(this.meta.retrievedAt, this.meta.sha256),
      },
    };
  }

  async ensureFresh(options: {
    fetchImpl?: typeof fetch;
    store?: { save(snapshot: OfacSnapshot): Promise<void> } | null;
    cachePath?: string;
    expectedSha256?: string | null;
  } = {}): Promise<void> {
    const cachePath = options.cachePath ?? CACHE_PATH;
    if (!this.meta) this.readCache(cachePath);
    if (this.meta && this.now() - Date.parse(this.meta.retrievedAt) <= FRESH_MS) return;
    try {
      const snapshot = await downloadOfacSnapshot({
        fetchImpl: options.fetchImpl,
        expectedSha256: options.expectedSha256 ?? null,
        retrievedAt: new Date(this.now()).toISOString(),
      });
      this.load(snapshot);
      this.writeCache(cachePath, snapshot);
      await options.store?.save(snapshot);
    } catch (error) {
      if (error instanceof OfacScreenError && error.code === "HASH_MISMATCH") {
        console.error("OFAC refresh failed. The file hash does not match the published digest.");
      } else if (error instanceof OfacScreenError && error.code === "EMPTY_LIST") {
        console.error("OFAC refresh failed. The file contained no digital currency addresses.");
      } else {
        console.error("OFAC refresh failed. Screening stays on the last loaded list.");
      }
    }
  }

  private usable(): boolean {
    return (
      this.meta !== null &&
      this.hits.size > 0 &&
      this.now() - Date.parse(this.meta.retrievedAt) <= STALE_MS
    );
  }

  private readCache(path: string): void {
    try {
      const snapshot = JSON.parse(readFileSync(path, "utf8")) as OfacSnapshot;
      if (snapshot.addresses?.length) this.load(snapshot);
    } catch {
      // No local index yet.
    }
  }

  private writeCache(path: string, snapshot: OfacSnapshot): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(snapshot));
  }
}

export async function downloadOfacSnapshot(options: {
  url?: string;
  fetchImpl?: typeof fetch;
  expectedSha256?: string | null;
  retrievedAt?: string;
} = {}): Promise<OfacSnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = options.url ?? OFAC_SOURCE_URL;
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) throw new OfacScreenError("CHECK_UNAVAILABLE");
      const digest = officialSha256FromDigest(response.headers.get("digest"));
      const read = await readHashedXml(readableFrom(response.body));
      const official = options.expectedSha256?.toLowerCase() ?? digest;
      if (official && official !== read.sha256) throw new OfacScreenError("HASH_MISMATCH");
      if (read.addresses.length === 0) throw new OfacScreenError("EMPTY_LIST");
      const counts = countByCurrency(read.addresses);
      return {
        id: randomUUID(),
        retrievedAt: options.retrievedAt ?? new Date().toISOString(),
        sourceUrl: url,
        sha256: read.sha256,
        addressCount: read.addresses.length,
        solAddressCount: counts.SOL ?? 0,
        counts,
        addresses: read.addresses,
      };
    } catch (error) {
      if (error instanceof OfacScreenError && error.code !== "CHECK_UNAVAILABLE") throw error;
      last = error;
    }
  }
  throw last instanceof Error ? last : new OfacScreenError("CHECK_UNAVAILABLE");
}

export function createSupabaseOfacStore(client: SupabaseClient): {
  save(snapshot: OfacSnapshot): Promise<void>;
} {
  return {
    async save(snapshot) {
      const inserted = await client
        .from("ofac_list_versions")
        .insert({
          id: snapshot.id,
          retrieved_at: snapshot.retrievedAt,
          source_url: snapshot.sourceUrl,
          sha256: snapshot.sha256,
          address_count: snapshot.addressCount,
          sol_address_count: snapshot.solAddressCount,
        })
        .select("id")
        .single();
      if (inserted.error || !inserted.data) {
        throw new OfacScreenError("CHECK_UNAVAILABLE");
      }
      const versionId = inserted.data.id as string;
      for (let index = 0; index < snapshot.addresses.length; index += 500) {
        const chunk = snapshot.addresses.slice(index, index + 500).map((row) => ({
          version_id: versionId,
          address: row.address,
          currency: row.currencySymbol,
          sdn_entry_id: row.sdnEntryId,
        }));
        const wrote = await client.from("ofac_addresses").insert(chunk);
        if (wrote.error) throw new OfacScreenError("CHECK_UNAVAILABLE");
      }
      const listed = await client
        .from("ofac_list_versions")
        .select("id")
        .order("retrieved_at", { ascending: false });
      if (listed.error) throw new OfacScreenError("CHECK_UNAVAILABLE");
      const drop = versionsToDrop((listed.data ?? []).map((row) => String(row.id)));
      for (const id of drop) {
        const removed = await client.from("ofac_list_versions").delete().eq("id", id);
        if (removed.error) throw new OfacScreenError("CHECK_UNAVAILABLE");
      }
    },
  };
}

type PendingAddress = { address: string; symbol: string; profileId: string };

export async function parseOfacAdvancedXml(xml: Buffer | string): Promise<OfacAddress[]> {
  const read = await readHashedXml(Readable.from([xml]));
  return read.addresses;
}

async function readHashedXml(stream: Readable): Promise<{ sha256: string; addresses: OfacAddress[] }> {
  const hash = createHash("sha256");
  const parser = sax.createStream(true, { trim: false, xmlns: false });
  const featureTypes = new Map<string, string>();
  const programs = new Map<string, string>();
  const legalBasisProgramId = new Map<string, string>();
  const profileEntries = new Map<string, Set<string>>();
  const entryProfiles = new Map<string, string>();
  const entryPrograms = new Map<string, Set<string>>();
  const pending: PendingAddress[] = [];
  const stack: Array<{ name: string; attrs: Record<string, string>; text: string }> = [];
  let profileId = "";
  let currency: string | null = null;
  let entryId = "";
  let skipDepth = 0;

  const done = new Promise<void>((resolve, reject) => {
    parser.on("error", reject);
    parser.on("end", () => resolve());
    parser.on("opentag", (tag) => {
      const name = localName(tag.name);
      const attrs = tag.attributes;
      stack.push({ name, attrs, text: "" });
      if (skipDepth > 0) {
        skipDepth += 1;
        return;
      }
      if (attrs.DeltaAction === "delete") {
        skipDepth = 1;
        return;
      }
      if (name === "Profile") profileId = attrs.ID ?? "";
      if (name === "Feature") currency = featureTypes.get(attrs.FeatureTypeID ?? "") ?? null;
      if (name === "SanctionsEntryReference" && profileId && attrs.SanctionsEntryID) {
        const set = profileEntries.get(profileId) ?? new Set<string>();
        set.add(attrs.SanctionsEntryID);
        profileEntries.set(profileId, set);
      }
      if (name === "SanctionsEntry") {
        entryId = attrs.ID ?? "";
        if (entryId && attrs.ProfileID) entryProfiles.set(entryId, attrs.ProfileID);
      }
      if (name === "EntryEvent" && entryId && attrs.LegalBasisID) {
        const program = programs.get(legalBasisProgramId.get(attrs.LegalBasisID) ?? "");
        if (program) {
          const set = entryPrograms.get(entryId) ?? new Set<string>();
          set.add(program);
          entryPrograms.set(entryId, set);
        }
      }
    });
    parser.on("text", (text) => {
      if (skipDepth === 0) appendText(stack, text);
    });
    parser.on("cdata", (text) => {
      if (skipDepth === 0) appendText(stack, text);
    });
    parser.on("closetag", () => {
      const closed = stack.pop();
      if (skipDepth > 0) {
        skipDepth -= 1;
        if (closed?.name === "Feature") currency = null;
        if (closed?.name === "Profile") profileId = "";
        if (closed?.name === "SanctionsEntry") entryId = "";
        return;
      }
      if (!closed) return;
      const text = closed.text.trim();
      if (closed.name === "FeatureType" && text.startsWith(ADDRESS_PREFIX)) {
        featureTypes.set(closed.attrs.ID ?? "", text.slice(ADDRESS_PREFIX.length).trim());
      }
      if (closed.name === "SanctionsProgram" && closed.attrs.ID) {
        programs.set(closed.attrs.ID, text);
      }
      if (closed.name === "LegalBasis" && closed.attrs.ID && closed.attrs.SanctionsProgramID) {
        legalBasisProgramId.set(closed.attrs.ID, closed.attrs.SanctionsProgramID);
      }
      if (closed.name === "VersionDetail" && currency && text && profileId) {
        pending.push({
          address: normalizeListedAddress(text),
          symbol: currency,
          profileId,
        });
      }
      if (closed.name === "Feature") currency = null;
      if (closed.name === "Profile") profileId = "";
      if (closed.name === "SanctionsEntry") entryId = "";
    });
  });

  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buf);
    if (!parser.write(buf)) await once(parser, "drain");
  }
  parser.end();
  await done;
  return { sha256: hash.digest("hex"), addresses: finishAddresses(pending, profileEntries, entryProfiles, entryPrograms) };
}

function finishAddresses(
  pending: PendingAddress[],
  profileEntries: Map<string, Set<string>>,
  entryProfiles: Map<string, string>,
  entryPrograms: Map<string, Set<string>>,
): OfacAddress[] {
  const grouped = new Map<string, OfacAddress>();
  for (const row of pending) {
    const entryIds = new Set<string>(profileEntries.get(row.profileId) ?? []);
    for (const [entryId, profileId] of entryProfiles) {
      if (profileId === row.profileId) entryIds.add(entryId);
    }
    const programNames = new Set<string>();
    for (const entryId of entryIds) {
      for (const program of entryPrograms.get(entryId) ?? []) programNames.add(program);
    }
    const next: OfacAddress = {
      address: row.address,
      currencySymbol: row.symbol,
      sdnEntryId: [...entryIds].sort().join(","),
      programs: [...programNames].sort(),
    };
    const key = `${next.currencySymbol}\n${next.address}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, next);
      continue;
    }
    const ids = new Set(
      [...existing.sdnEntryId.split(","), ...next.sdnEntryId.split(",")].filter(Boolean),
    );
    existing.sdnEntryId = [...ids].sort().join(",");
    existing.programs = [...new Set([...existing.programs, ...next.programs])].sort();
  }
  return [...grouped.values()];
}

function appendText(
  stack: Array<{ name: string; text: string }>,
  text: string,
): void {
  const current = stack[stack.length - 1];
  if (!current) return;
  if (
    current.name === "FeatureType" ||
    current.name === "SanctionsProgram" ||
    current.name === "VersionDetail"
  ) {
    current.text += text;
  }
}

function localName(name: string): string {
  const index = name.indexOf(":");
  return index === -1 ? name : name.slice(index + 1);
}

function readableFrom(body: ReadableStream<Uint8Array>): Readable {
  return Readable.from(body as AsyncIterable<Uint8Array>);
}
