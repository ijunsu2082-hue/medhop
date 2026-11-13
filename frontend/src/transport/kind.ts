// Which backend this build talks to. It is fixed when the site is built (VITE_BACKEND) and never changes while a
// page is open: a page that was controlling a real drone must not quietly turn into a simulator.

export type BackendKind = "browser" | "python";

/** "browser": the simulator runs inside this page. "python": the MedHop backend on this computer (simulator or real drone). */
export const BACKEND_KIND: BackendKind = import.meta.env.VITE_BACKEND === "browser" ? "browser" : "python";
