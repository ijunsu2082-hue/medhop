import { NavLink, Outlet, useLocation } from "react-router-dom";
import { API_BASE } from "../api/config";
import { useStatus } from "../hooks/useStatus";
import { backendDownText } from "../text/shellWording";
import { FOOTER_TEXT } from "../text/wording";
import { IconCross, IconMark } from "./Icons";

type Route = "pilot" | "care" | "caregiver" | "other";

function routeOf(pathname: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return "pilot";
  if (path === "/care") return "care";
  if (path === "/caregiver") return "caregiver";
  return "other";
}

function BackendLine() {
  const { reachable, socket } = useStatus();
  let text: string;
  let tone: "pass" | "warn" | "fail";
  if (reachable === false) {
    text = "Backend not reachable";
    tone = "fail";
  } else if (reachable === null) {
    text = "Connecting";
    tone = "warn";
  } else if (socket === "open") {
    text = "Live";
    tone = "pass";
  } else {
    text = "Live (polling)";
    tone = "warn";
  }
  return (
    <span className={`status-line tone-${tone}`} title="Status link to the MedHop backend">
      <span className="status-sq" aria-hidden="true" />
      <span>
        <span className="sr-only">Status: </span>
        {text}
      </span>
    </span>
  );
}

const PAGES = [
  { to: "/", label: "Pilot", end: true },
  { to: "/care", label: "Care", end: false },
  { to: "/caregiver", label: "Caregiver", end: false },
] as const;

function PageLinks({ className }: { className: string }) {
  const list = (
    <ul>
      {PAGES.map((p) => (
        <li key={p.to}>
          <NavLink to={p.to} end={p.end} data-label={p.label}>
            {p.label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
  if (className === "pagelinks") {
    return (
      <nav aria-label="Pages" className="pagelinks">
        <div className="container">{list}</div>
      </nav>
    );
  }
  return (
    <nav aria-label="Pages" className={className}>
      {list}
    </nav>
  );
}

export function Layout() {
  const { reachable, status } = useStatus();
  const route = routeOf(useLocation().pathname);
  // The Pilot page states the mode in its own command strip, so the masthead repeats it only on the other pages.
  const showMode = status?.mode === "sim" && route !== "pilot";
  // On the Care page the header stays quiet: the page links move below the content.
  const linksInHeader = route !== "care";
  const pageHost = typeof window === "undefined" ? "localhost" : window.location.hostname;
  return (
    <div className={`app app--${route}`}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="masthead">
        <div className="masthead-inner container">
          <span className="brand">
            <IconMark className="brand-mark" size={24} />
            <span className="brand-name">MedHop</span>
          </span>
          {linksInHeader && <PageLinks className="masthead-nav" />}
          <div className="masthead-status">
            {showMode && <span className="stamp">Mode: simulator</span>}
            <BackendLine />
          </div>
        </div>
      </header>
      {reachable === false && (
        <div className="banner banner-fail" role="status">
          <IconCross size={20} />
          <span>{backendDownText(pageHost, API_BASE)}</span>
        </div>
      )}
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
      {!linksInHeader && <PageLinks className="pagelinks" />}
      <footer className="footer">
        <div className="container">{FOOTER_TEXT}</div>
      </footer>
    </div>
  );
}
