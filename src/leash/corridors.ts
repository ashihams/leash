export const CROSS_BORDER_ROUTES = [
  {
    id: "US-IN",
    fromCountry: "US",
    toCountry: "IN",
    label: "United States → India",
    currency: "INR",
  },
  {
    id: "US-GB",
    fromCountry: "US",
    toCountry: "GB",
    label: "United States → United Kingdom",
    currency: "GBP",
  },
  {
    id: "US-DE",
    fromCountry: "US",
    toCountry: "DE",
    label: "United States → Germany",
    currency: "EUR",
  },
  {
    id: "US-PH",
    fromCountry: "US",
    toCountry: "PH",
    label: "United States → Philippines",
    currency: "PHP",
  },
] as const;

export type PaymentRoute = { fromCountry: string; toCountry: string };
export type FxQuote = {
  base: "USDC";
  currency: string;
  rate: number;
  usdRate: number;
  source: "Coinbase";
  fetchedAt: string;
  expiresAt: string;
};

export function countrySeed(country: string): Uint8Array {
  if (!/^[A-Z]{2}$/.test(country)) throw new Error("Invalid country code");
  return new TextEncoder().encode(country);
}

export function formatLocalAmount(usdc: number, quote: FxQuote): string {
  if (
    !Number.isFinite(usdc) ||
    usdc <= 0 ||
    !Number.isFinite(quote.rate) ||
    quote.rate <= 0
  )
    return "—";
  const converted = usdc * quote.rate;
  if (!Number.isFinite(converted)) return "—";
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: quote.currency,
    maximumFractionDigits: 2,
  }).format(converted);
}
