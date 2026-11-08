export type LogLine = {
  title: string;
  detail: string;
  signature?: string;
  testOutcome?: "pass" | "fail" | "unavailable";
};

export function bannerFrom(lines: LogLine[]) {
  // A newly registered mandate starts a new decision context. Keep older
  // evidence in the timeline without carrying its refusal into this mandate.
  const boundary = lines.findIndex(
    (line) => line.title === "Mandate registered"
  );
  const current = boundary < 0 ? lines : lines.slice(0, boundary);
  const decision = current.find(
    (line) =>
      line.testOutcome ||
      /Allow|Deny|refused|Revoked|Swapped|Forced/i.test(line.title)
  );
  if (!decision) {
    const review = current.find((line) =>
      /review/i.test(`${line.title} ${line.detail}`)
    );
    return review
      ? {
          tone: "review" as const,
          title: "Needs review",
          detail: review.detail,
        }
      : null;
  }
  if (decision.testOutcome === "pass") {
    return {
      tone: "cleared" as const,
      title: "Protection passed",
      detail: decision.detail,
    };
  }
  if (decision.testOutcome === "fail") {
    return {
      tone: "refused" as const,
      title: "Protection test failed",
      detail: decision.detail,
    };
  }
  if (decision.testOutcome === "unavailable") {
    return {
      tone: "review" as const,
      title: "Test unavailable",
      detail: decision.detail,
    };
  }
  const blob = `${decision.title} ${decision.detail}`;
  if (
    /Swapped|Deny|refused|Revoked/i.test(decision.title) ||
    /does not verify/i.test(blob)
  ) {
    return {
      tone: "refused" as const,
      title: "Refused",
      detail: decision.detail,
    };
  }
  if (/Allow/i.test(decision.title)) {
    return {
      tone: "cleared" as const,
      title: "Gate approved",
      detail: `${decision.detail} This approval is not a confirmed transfer; check the transaction steps below.`,
    };
  }
  return {
    tone: "review" as const,
    title: "Needs review",
    detail: decision.detail,
  };
}

export function markFor(line: LogLine): "pass" | "flag" | "fail" | "info" {
  if (line.testOutcome)
    return line.testOutcome === "unavailable" ? "flag" : line.testOutcome;
  const blob = `${line.title} ${line.detail}`;
  if (/Adapt|REVIEW|flag/i.test(blob)) return "flag";
  if (
    /Deny|refused|fail|does not verify|not running|Could not|nothing to/i.test(
      blob
    )
  ) {
    return "fail";
  }
  if (/Allow|verifies|open|signed/i.test(blob)) return "pass";
  return "info";
}

export function mandateRecovery(reasons: string[]) {
  if (reasons.includes("MANDATE_REVOKED")) {
    return "This mandate is revoked. Choose Open the next mandate, complete its setup, then ask for a clearance again.";
  }
  if (reasons.includes("BUDGET")) {
    return "This payment exceeds the mandate's remaining budget. Reduce the amount to fit the remaining budget, or open the next mandate. Depositing USDC does not reset its spending limit.";
  }
  return null;
}
