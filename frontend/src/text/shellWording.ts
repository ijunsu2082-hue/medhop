// Wording for the app shell (masthead, backend banner). Strings in wording.ts stay untouched; shell-only text lives here.

/** True when a hostname points at this computer. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1" || h.endsWith(".localhost");
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export const BACKEND_DOWN_LOCAL = "Backend not reachable. Retrying every 2 seconds.";

export const BACKEND_DOWN_REMOTE_PAGE =
  "This page is only the interface. It needs the MedHop backend running on this computer: start it with Start simulator.command, then open http://localhost:5180.";

/**
 * Text for the "backend not reachable" banner. When the page itself is served from somewhere else (for example a
 * hosted preview) but the API base still points at this computer, retrying will never help, so say what to do instead.
 */
export function backendDownText(pageHostname: string, apiBase: string): string {
  const apiHost = hostnameOf(apiBase);
  if (!isLocalHost(pageHostname) && apiHost !== null && isLocalHost(apiHost)) return BACKEND_DOWN_REMOTE_PAGE;
  return BACKEND_DOWN_LOCAL;
}
