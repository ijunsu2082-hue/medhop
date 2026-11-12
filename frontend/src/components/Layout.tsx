import { NavLink, Outlet } from "react-router-dom";
import { useStatus } from "../hooks/useStatus";
import { FOOTER_TEXT } from "../text/wording";

function BackendLine() {
  const { reachable, socket } = useStatus();
  let text: string;
  let cls: string;
  if (reachable === false) {
    text = "Backend not reachable";
    cls = "fail";
  } else if (reachable === null) {
    text = "Connecting";
    cls = "warn";
  } else if (socket === "open") {
    text = "Live";
    cls = "pass";
  } else {
    text = "Live (polling)";
    cls = "warn";
  }
  return (
    <span className={`conn conn-${cls}`} title="Status link to the MedHop backend">
      <span className="conn-dot" aria-hidden="true" />
      <span>
        <span className="sr-only">Status: </span>
        {text}
      </span>
    </span>
  );
}

export function Layout() {
  const { reachable } = useStatus();
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topnav">
        <span className="brand">MedHop</span>
        <nav aria-label="Pages">
          <ul>
            <li>
              <NavLink to="/" end>
                Pilot
              </NavLink>
            </li>
            <li>
              <NavLink to="/care">Care</NavLink>
            </li>
            <li>
              <NavLink to="/caregiver">Caregiver</NavLink>
            </li>
          </ul>
        </nav>
        <BackendLine />
      </header>
      {reachable === false && (
        <div className="banner banner-fail" role="status">
          Backend not reachable. Retrying every 2 seconds.
        </div>
      )}
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
      <footer className="footer">{FOOTER_TEXT}</footer>
    </div>
  );
}
