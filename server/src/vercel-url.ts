export function gateRequestUrl(url: string, rawPath: unknown): string {
  const original = new URL(url, "http://localhost");
  const parts = Array.isArray(rawPath)
    ? rawPath
    : typeof rawPath === "string" && rawPath
      ? [rawPath]
      : [];
  const suffix =
    parts.join("/") || original.pathname.replace(/^\/api\/gate\/?/, "");
  original.searchParams.delete("__gatePath");
  return `/${suffix}${original.search}`;
}
