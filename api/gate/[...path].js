import { gateApp } from "../generated/gate.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(request, response) {
  const query = request.query || {};
  const raw = query.path ?? query["...path"];
  const parts = Array.isArray(raw) ? raw : typeof raw === "string" && raw ? [raw] : [];
  let suffix = parts.join("/");
  if (!suffix) {
    suffix = (request.url || "").split("?")[0].replace(/^\/api\/gate\/?/, "");
  }
  request.url = `/${suffix}`;
  const application = gateApp();
  await application.ready();
  application.server.emit("request", request, response);
}
