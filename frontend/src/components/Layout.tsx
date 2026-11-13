import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useStatus } from "../hooks/useStatus";
import { BACKEND_DOWN, modeLabel } from "../text/shellWording";
import { FOOTER_TEXT } from "../text/wording";
import { BACKEND_KIND } from "../transport/kind";

type Route = "pilot" | "care" | "caregiver" | "other";

function routeOf(pathname: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/pilot") return "pilot";
  if (path === "/care") return "care";
  if (path === "/caregiver") return "caregiver";
  return "other";
}

const PAGES = [
  { to: "/pilot", label: "Pilot" },
  { to: "/care", label: "Care" },
  { to: "/caregiver", label: "Caregiver" },
] as const;

function PageLinks() {
  return (
    <ul>
      {PAGES.map((p) => (
        <li key={p.to}>
          <NavLink to={p.to}>{p.label}</NavLink>
        </li>
      ))}
    </ul>
  );
}

/** The site name and, always beside it, what this page is connected to. */
export function Brand() {
  const { reachable, status } = useStatus();
  const mode = modeLabel(BACKEND_KIND, reachable, status?.mode ?? null);
  return (
    <>
      <Link className="brand" to="/">
        Med<span className="brand-hop">Hop</span>
      </Link>
      <span className={`mode mode--${mode.tone}`}>
        <span className="sr-only">Connected to: </span>
        {mode.text}
      </span>
    </>
  );
}

export function Layout() {
  const { reachable } = useStatus();
  const route = routeOf(useLocation().pathname);
  // On the Care page the header stays quiet: the page links move below the content.
  const linksInHeader = route !== "care";
  return (
    <div className={`app app--${route}`}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="masthead">
        <div className="masthead-inner container">
          <Brand />
          {linksInHeader && (
            <nav aria-label="Pages" className="nav">
              <PageLinks />
            </nav>
          )}
        </div>
      </header>
      {BACKEND_KIND === "python" && reachable === false && (
        <div className="banner banner-fail" role="status">
          {BACKEND_DOWN}
        </div>
      )}
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
      {!linksInHeader && (
        <nav aria-label="Pages" className="pagelinks">
          <div className="container">
            <PageLinks />
          </div>
        </nav>
      )}
      <footer className="footer">
        <div className="container">{FOOTER_TEXT}</div>
      </footer>
    </div>
  );
}
