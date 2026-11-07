import { useEffect, useState } from "react";
import { Dashboard } from "./Dashboard";
import { Landing } from "./Landing";

export default function App() {
  const route = useHashRoute();

  return (
    <>
      <a className="k-skip" href="#content">
        Skip to content
      </a>
      {route === "dashboard" ? <Dashboard /> : <Landing />}
    </>
  );
}

function useHashRoute() {
  const [route, setRoute] = useState(readRoute);

  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return route;
}

function readRoute() {
  return window.location.hash.startsWith("#/dashboard") ? "dashboard" : "home";
}
