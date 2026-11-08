import { DEVNET_RPC, PROGRAM_ID } from "./deployment.ts";

export type PaymentReadiness = {
  program: string;
  rpc: string;
  programDeployed: boolean;
  configurationReady: boolean;
  mismatches: string[];
  routes: Array<{
    id: string;
    status: "missing" | "invalid" | "disabled" | "ready";
    limitsMatch: boolean;
  }>;
};

export function paymentSetupIssue(state: PaymentReadiness, routeId: string) {
  if (state.program !== PROGRAM_ID || state.rpc !== DEVNET_RPC) {
    return {
      title: "Configuration mismatch",
      detail:
        "The backend and wallet client target different Solana deployments.",
    };
  }
  if (!state.programDeployed) {
    return {
      title: "Deployment required",
      detail:
        "The Leash program is missing on devnet. Complete deployment before making a payment.",
    };
  }
  if (!state.configurationReady) {
    return {
      title: "Configuration mismatch",
      detail: `The backend does not match the devnet configuration (${state.mismatches.join(", ")}). Payment setup is blocked.`,
    };
  }
  const route = state.routes.find((item) => item.id === routeId);
  if (!route || route.status === "missing") {
    return {
      title: "Route setup required",
      detail: `${routeId.replace("-", " → ")} has no route account on devnet. The program administrator must initialize it before payments can start.`,
    };
  }
  if (route.status !== "ready") {
    return {
      title: "Route unavailable",
      detail: `${routeId.replace("-", " → ")} is ${route.status} on devnet. The program administrator must resolve this before payment.`,
    };
  }
  if (!route.limitsMatch) {
    return {
      title: "Route configuration mismatch",
      detail: `${routeId.replace("-", " → ")} has different payment limits in the backend and on devnet. The administrator must align them before payment.`,
    };
  }
  return null;
}
