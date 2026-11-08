import { gateApp, gateRequestUrl } from "./generated/gate.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(request, response) {
  const query = request.query || {};
  const raw = query.__gatePath;
  request.url = gateRequestUrl(request.url || "/", raw);
  const application = gateApp();
  await application.ready();
  application.server.emit("request", request, response);
}
