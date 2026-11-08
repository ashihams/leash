import { Arrow, Drift, Marquee, SiteHeader } from "./ui";

const steps = [
  [
    "01",
    "The owner deposits test USDC into a treasury the agent cannot withdraw.",
  ],
  [
    "02",
    "The agent requests one payment. The request carries the agent's signature, not the owner's.",
  ],
  [
    "03",
    "The gate signs a 288-byte clearance naming the vendor, mint, amount, and corridor.",
  ],
  [
    "04",
    "The program moves that USDC from the treasury into an escrow for one payment id.",
  ],
  [
    "05",
    "The vendor submits a receipt. A separate verifier checks the bytes and the hash.",
  ],
  [
    "06",
    "A fresh clearance releases the escrow. A denial leaves the funds in place.",
  ],
];

const rows = [
  {
    index: "01",
    title: "Mandate",
    copy: "The owner names the agent, a 2 USDC budget, a per-payment cap, a category, and the corridors. Revoke blocks the next funding. It does not cancel an escrow that is already funded.",
  },
  {
    index: "02",
    title: "Clearance",
    copy: "The signed message is 288 bytes. It binds the payment, mandate, buyer, vendor, mint, amount, corridor, and invoice. The program accepts it only when every field matches the accounts.",
  },
  {
    index: "03",
    title: "Escrow",
    copy: "USDC leaves the treasury only for that payment id. The agent can request the payment. It cannot choose a different wallet at release.",
  },
  {
    index: "04",
    title: "Verifier",
    copy: "A separate key checks that the receipt is non-empty, starts with DLV1, and hashes to the receipt the vendor submitted. It cannot change the buyer, vendor, mint, or amount.",
  },
];

export function Landing() {
  return (
    <div className="k-page">
      <SiteHeader route="home" />
      <main id="content">
        <section className="k-hero" aria-labelledby="hero-title">
          <h1 id="hero-title" className="k-display">
            <Drift direction={1}>
              <span className="k-line">This agent</span>
            </Drift>
            <span className="k-line k-band">Has a wallet</span>
            <Drift direction={-1}>
              <span className="k-line k-right">It does not</span>
            </Drift>
            <span className="k-line">Have authority</span>
          </h1>
          <div className="k-hero-support">
            <p>
              An owner gives an agent a 2 USDC leash to buy services. The agent
              can ask for a payment. The owner's wallet stays with the owner.
              The USDC sits in a treasury the program controls.
            </p>
            <div className="k-actions">
              <a className="k-action" href="#/dashboard">
                Open the dashboard
                <Arrow />
              </a>
              <a className="k-action k-action-ghost" href="#refusals">
                Read the refusals
                <Arrow />
              </a>
            </div>
          </div>
        </section>

        <Marquee />

        <section className="k-section" aria-labelledby="payment-title">
          <h2 id="payment-title" className="k-section-title k-arrive">
            The payment
          </h2>
          <ol className="k-steps">
            {steps.map(([index, copy]) => (
              <li key={index}>
                <span>{index}</span>
                <p>{copy}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="k-section" aria-labelledby="parts-title">
          <h2 id="parts-title" className="k-section-title k-arrive">
            What holds
          </h2>
          <div>
            {rows.map((row) => (
              <article className="k-feature" key={row.index}>
                <span className="k-index">{row.index}</span>
                <h3>{row.title}</h3>
                <p className="k-numeral" aria-hidden="true">
                  {row.index}
                </p>
                <p className="k-panel">{row.copy}</p>
              </article>
            ))}
          </div>
        </section>

        <section
          className="k-orange"
          id="refusals"
          aria-labelledby="refuse-title"
        >
          <h2 id="refuse-title">The program refuses</h2>
          <div className="k-orange-grid">
            <p>
              A clearance with the vendor swapped, even when the signature was
              real for a different vendor.
            </p>
            <p>
              An allow signed after the corridor is disabled. The signer can say
              yes. The program still returns corridor blocked.
            </p>
            <p>
              The next funding after the owner revokes, even when the gate is
              pushed to sign an allow.
            </p>
          </div>
        </section>

        <section className="k-section" aria-labelledby="holds-title">
          <h2 id="holds-title" className="k-section-title k-arrive">
            Who holds what
          </h2>
          <div className="k-table" role="table" aria-label="Who holds what">
            <div className="k-compare" role="row">
              <span role="columnheader">Key</span>
              <span role="columnheader">Can do</span>
              <span role="columnheader">Cannot do</span>
            </div>
            {[
              [
                "Owner wallet",
                "Fund the treasury and revoke the mandate",
                "It is never handed to the agent",
              ],
              [
                "Agent key",
                "Request a payment inside the mandate",
                "Withdraw the treasury or change the vendor",
              ],
              [
                "Policy signer",
                "Sign the clearance the program checks",
                "Hold the USDC or move it alone",
              ],
            ].map(([key, can, cannot]) => (
              <div className="k-compare" role="row" key={key}>
                <strong role="cell">{key}</strong>
                <span role="cell">{can}</span>
                <span role="cell">{cannot}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="k-section" aria-labelledby="close-title">
          <blockquote>
            <p id="close-title" className="k-quote">
              The agent has a wallet. But it doesn't have authority. Leash does.
            </p>
          </blockquote>
          <div className="k-close">
            <h2 className="k-display k-display-end">
              <span className="k-line">Watch it</span>
              <span className="k-line k-right">Go off</span>
              <span className="k-line k-band">The leash</span>
            </h2>
            <Arrow />
          </div>
          <a className="k-action" href="#/dashboard">
            Open the dashboard
            <Arrow />
          </a>
        </section>

        <footer className="k-footer">
          <div>
            <span>Program</span>
            <span>8Eq2Ug3URR5ugzDfjYk4bbkBJa8o7U6YZtPp6vLDHezd</span>
          </div>
          <div>
            <span>Cluster</span>
            <span>Devnet</span>
          </div>
          <div>
            <span>Clearance</span>
            <span>288 bytes</span>
          </div>
          <div>
            <span>Screening</span>
            <span>OFAC SDN list</span>
          </div>
          <p>
            Leash is not a regulated compliance provider and makes no compliance
            claims. No match on the OFAC SDN list (US Treasury) means only that
            the address was absent from the retrieved file. OFAC states its
            digital currency address listings are not exhaustive. EU, UN and
            other lists are not covered. A compromised policy signer can still
            approve a payment that satisfies the on-chain checks.
          </p>
        </footer>
      </main>
    </div>
  );
}
