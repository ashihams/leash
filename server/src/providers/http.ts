export class ProviderHttpError extends Error {
  code: "TIMEOUT" | "HTTP" | "NETWORK" | "MALFORMED";

  constructor(code: ProviderHttpError["code"]) {
    super(code);
    this.code = code;
  }
}

export type ProviderResponse = {
  status: number;
  body: unknown;
};

type FetchLike = typeof fetch;

export async function providerRequest(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike = fetch,
): Promise<ProviderResponse> {
  let last: ProviderHttpError | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(3_000),
      });
      const text = await response.text();
      if (response.status >= 500) {
        last = new ProviderHttpError("HTTP");
        continue;
      }
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          throw new ProviderHttpError("MALFORMED");
        }
      }
      return { status: response.status, body };
    } catch (error) {
      if (error instanceof ProviderHttpError) {
        if (error.code === "MALFORMED") throw error;
        last = error;
        continue;
      }
      const name = error instanceof Error ? error.name : "";
      last = new ProviderHttpError(
        name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : "NETWORK",
      );
    }
  }
  throw last ?? new ProviderHttpError("NETWORK");
}
