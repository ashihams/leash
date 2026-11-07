import { useEffect, useRef, useState, type ReactNode } from "react";

export function Arrow({
  direction = "right",
}: {
  direction?: "right" | "left";
}) {
  return (
    <svg className="k-arrow" viewBox="0 0 72 32" aria-hidden="true">
      {direction === "left" ? (
        <path
          d="M72 16H12M24 4L4 16l20 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
        />
      ) : (
        <path
          d="M0 16h60M48 4l20 12-20 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
        />
      )}
    </svg>
  );
}

export function SiteHeader({ route }: { route: "home" | "dashboard" }) {
  return (
    <header className="k-nav">
      <a className="k-mark" href="#/">
        Leash
      </a>
      <nav aria-label="Pages">
        <a href="#/" aria-current={route === "home" ? "page" : undefined}>
          Landing
        </a>
        <a
          href="#/dashboard"
          aria-current={route === "dashboard" ? "page" : undefined}
        >
          Dashboard
        </a>
      </nav>
    </header>
  );
}

export function Marquee() {
  const [paused, setPaused] = useState(false);
  const [reduce, setReduce] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduce(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const text =
    "Bounded agent authority · Revocable spend · The agent does not hold the USDC · ";

  return (
    <div className="k-marquee-wrap">
      <p className="sr-only">{text}</p>
      <div
        className="k-marquee"
        data-paused={paused || reduce ? "true" : "false"}
        aria-hidden="true"
      >
        <div className="k-marquee-track">
          <span>{text.repeat(4)}</span>
          <span>{text.repeat(4)}</span>
        </div>
      </div>
      <button
        type="button"
        className="k-pause"
        aria-pressed={paused || reduce}
        onClick={() => setPaused((value) => !value)}
      >
        {paused || reduce ? "Motion paused" : "Pause motion"}
      </button>
    </div>
  );
}

export function Drift({
  children,
  direction,
}: {
  children: ReactNode;
  direction: 1 | -1;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const node = ref.current;
    if (!node || media.matches) return;
    const onScroll = () => {
      const progress = Math.min(window.scrollY, 280) / 280;
      node.style.transform = `translate3d(${progress * 18 * direction}px, 0, 0) scaleX(${1 - progress * 0.04})`;
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [direction]);

  return (
    <span className="k-drift" ref={ref}>
      {children}
    </span>
  );
}
