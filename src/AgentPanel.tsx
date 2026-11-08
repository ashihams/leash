import { useState } from "react";
import type { AgentResponse, AgentStep } from "./leash/agent-contract";

type Props = {
  goal: string;
  busy: boolean;
  runAgent: (goal: string, simulate: boolean) => Promise<AgentResponse>;
  approve: (proposal: AgentResponse) => Promise<void>;
};
export function AgentPanel({ goal, busy, runAgent, approve }: Props) {
  const [simulate, setSimulate] = useState(false);
  const [result, setResult] = useState<AgentResponse | null>(null);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [notice, setNotice] = useState("");
  const [running, setRunning] = useState(false);
  const [proposalGoal, setProposalGoal] = useState("");
  const [funded, setFunded] = useState(false);
  async function start() {
    setRunning(true);
    setResult(null);
    setSteps([]);
    setNotice("");
    setFunded(false);
    try {
      const response = await runAgent(goal, simulate);
      setResult(response);
      setSteps(response.steps);
      setProposalGoal(goal);
    } catch (error) {
      const failure = error as Error & { steps?: AgentStep[] };
      setNotice(failure.message || "The agent could not complete this run.");
      setSteps(failure.steps ?? []);
    } finally {
      setRunning(false);
    }
  }
  async function confirm() {
    if (!result || funded || proposalGoal !== goal) return;
    setRunning(true);
    setNotice("");
    try {
      await approve(result);
      setFunded(true);
      setNotice("Payment funded. See the transaction in Evidence.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Funding failed.");
    } finally {
      setRunning(false);
    }
  }
  return (
    <section className="d-agent" aria-labelledby="agent-title">
      <h2 id="agent-title">AI agent (untrusted: it can only propose)</h2>
      <p>
        The agent reads this goal and asks the gate for a proposal. Only your
        approval can start funding.
      </p>
      <label className="d-agent-toggle">
        <input
          type="checkbox"
          checked={simulate}
          disabled={busy || running}
          onChange={(event) => {
            setSimulate(event.target.checked);
            setResult(null);
            setSteps([]);
          }}
        />{" "}
        Simulate a compromised agent
      </label>
      {simulate ? (
        <p className="d-hint">
          <strong>SIMULATION:</strong> sends an attacker proposal through the
          real gate. No model choice or payment is made.
        </p>
      ) : null}
      <button
        className="d-btn d-btn-primary"
        type="button"
        disabled={busy || running || !goal.trim()}
        onClick={() => void start()}
      >
        {running ? "Working…" : "Run agent"}
      </button>
      <p className="d-hint">
        Dashboard login required. One run per minute. The existing gate reserves
        mandate budget when it approves a clearance; the agent itself sends no
        funds.
      </p>
      {notice ? <p role="status">{notice}</p> : null}
      {steps.length ? (
        <ol className="d-agent-trace" aria-label="Agent trace">
          {steps.map((step, index) => (
            <li key={`${index}-${step.argument_hash}`}>{step.summary}</li>
          ))}
        </ol>
      ) : null}
      {result ? (
        <div className="d-agent-review">
          <h3>
            {result.label === "SIMULATION"
              ? "SIMULATION — malicious proposal"
              : "Review proposal"}
          </h3>
          <p>{result.final.goal_summary.summary}</p>
          <dl className="d-terms">
            <div>
              <dt>Vendor</dt>
              <dd>{result.review.vendor_name}</dd>
            </div>
            <div>
              <dt>Vendor wallet</dt>
              <dd>
                <code>{result.final.chosen_vendor}</code>
              </dd>
            </div>
            <div>
              <dt>Amount</dt>
              <dd>{result.final.amount} USDC</dd>
            </div>
            <div>
              <dt>Corridor</dt>
              <dd>
                {result.review.corridor.fromCountry} →{" "}
                {result.review.corridor.toCountry}
              </dd>
            </div>
            <div>
              <dt>Mandate</dt>
              <dd>{result.review.mandate_id}</dd>
            </div>
            <div>
              <dt>Remaining before proposal</dt>
              <dd>{result.review.remaining_budget} USDC</dd>
            </div>
            <div>
              <dt>Gate decision</dt>
              <dd>{result.final.gate_result.decision}</dd>
            </div>
          </dl>
          <p>{result.final.explanation}</p>
          {result.final.reasons.length ? (
            <p>Gate reason codes: {result.final.reasons.join(", ")}</p>
          ) : null}
          <ul>
            {result.final.alternatives_considered.map((alternative, index) => (
              <li key={index}>
                <code>{alternative.vendor}</code>: {alternative.reason}
              </li>
            ))}
          </ul>
          <details>
            <summary>Gate checks</summary>
            <ul>
              {result.final.gate_result.checks.map((check) => (
                <li key={check.name}>
                  {check.name}: {check.status}
                </li>
              ))}
            </ul>
          </details>
          {result.label !== "SIMULATION" &&
          result.final.gate_result.decision === "allow" &&
          result.confirmation ? (
            <>
              <p>
                Review the vendor, amount and corridor before approving. Wallet
                confirmation may be required.
              </p>
              <button
                type="button"
                className="d-btn d-btn-primary"
                disabled={busy || running || funded || proposalGoal !== goal}
                onClick={() => void confirm()}
              >
                Approve and fund
              </button>
            </>
          ) : (
            <p className="d-hint">Funding is unavailable for this proposal.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
