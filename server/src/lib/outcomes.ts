export const VELOCITY_RECENT_LIMIT = 5;
export const RATIO_MIN_TOTAL = 5;
export const RATIO_MAX = 0.2;
export const RECENT_WINDOW_MS = 15 * 60 * 1000;

export type HistoryStatus =
  | "funded"
  | "delivered"
  | "verified"
  | "released"
  | "refunded"
  | "disputed";

export type HistoryPayment = {
  status: HistoryStatus;
  createdAt: string;
};

export type VendorStats = {
  total: number;
  refunded: number;
  disputed: number;
  recentCount: number;
  refundRatio: number | null;
  disputeRatio: number | null;
  screened: boolean;
};

export function vendorStats(
  rows: readonly HistoryPayment[],
  screened: boolean,
  nowMs: number,
): VendorStats {
  const total = rows.length;
  const refunded = rows.filter((row) => row.status === "refunded").length;
  const disputed = rows.filter((row) => row.status === "disputed").length;
  const recentCount = rows.filter((row) => {
    const created = Date.parse(row.createdAt);
    return created <= nowMs && nowMs - created <= RECENT_WINDOW_MS;
  }).length;
  const ratios = total >= RATIO_MIN_TOTAL;
  return {
    total,
    refunded,
    disputed,
    recentCount,
    refundRatio: ratios ? refunded / total : null,
    disputeRatio: ratios ? disputed / total : null,
    screened,
  };
}

export function expectedGateOutcome(stats: VendorStats): string {
  if (stats.screened) return "DENY CHECK_SCREENING";
  if (stats.recentCount >= VELOCITY_RECENT_LIMIT) return "DENY CHECK_VELOCITY";
  if (stats.refundRatio !== null && stats.refundRatio > RATIO_MAX) {
    return "DENY CHECK_REFUND_RATIO";
  }
  if (stats.disputeRatio !== null && stats.disputeRatio > RATIO_MAX) {
    return "DENY CHECK_DISPUTE_RATIO";
  }
  return "ALLOW";
}

function copies(
  count: number,
  status: HistoryStatus,
  createdAt: string,
): HistoryPayment[] {
  return Array.from({ length: count }, () => ({ status, createdAt }));
}

export type DemoVendorPlan = {
  key: string;
  name: string;
  country: string;
  screened: boolean;
  payments: HistoryPayment[];
  outcome: string;
};

export function buildDemoHistory(nowMs: number): DemoVendorPlan[] {
  const old = new Date(nowMs - 2 * 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date(nowMs - 5 * 60 * 1000).toISOString();
  const plans = [
    {
      key: "acme",
      name: "Acme Design",
      country: "IN",
      screened: false,
      payments: copies(8, "released", old),
    },
    {
      key: "brighthost",
      name: "BrightHost",
      country: "DE",
      screened: false,
      payments: copies(8, "released", old),
    },
    {
      key: "fastlane",
      name: "Fast Lane",
      country: "US",
      screened: false,
      payments: copies(6, "funded", recent),
    },
    {
      key: "returnly",
      name: "Returnly",
      country: "US",
      screened: false,
      payments: [
        ...copies(5, "released", old),
        ...copies(5, "refunded", old),
      ],
    },
    {
      key: "shadow",
      name: "Shadow Vendor",
      country: "US",
      screened: true,
      payments: copies(1, "released", old),
    },
  ];
  return plans.map((plan) => ({
    ...plan,
    outcome: expectedGateOutcome(
      vendorStats(plan.payments, plan.screened, nowMs),
    ),
  }));
}
