/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// VITE_BACKEND decides, when the site is built, which backend every page of it talks to (src/transport/index.ts):
//   python  (the default): the MedHop backend on this computer, simulator or real drone. npm run dev / build.
//   browser: the simulator runs inside the page. npm run dev:browser / build:browser (Vite mode "browser",
//            which reads .env.browser).
// It is never decided at run time, so a page that was flying the real drone cannot turn into a simulator.
const BACKENDS = ["python", "browser"] as const;
type Backend = (typeof BACKENDS)[number];

function backendOf(raw: string | undefined): Backend {
  const value = (raw ?? "").trim();
  if (value === "") return "python";
  if ((BACKENDS as readonly string[]).includes(value)) return value as Backend;
  throw new Error(
    `VITE_BACKEND is "${value}", which is not a backend this site knows. Use "python" (the MedHop backend on this ` +
      `computer; also what an unset VITE_BACKEND means) or "browser" (the simulator inside the page). The backend ` +
      `is fixed when the site is built, so a wrong value stops the build here instead of producing a site that ` +
      `talks to the wrong thing.`,
  );
}

export default defineConfig(({ command, mode }) => {
  const backend = backendOf(loadEnv(mode, process.cwd(), "VITE_").VITE_BACKEND);
  if (command === "build" && process.env.NETLIFY && backend !== "browser") {
    throw new Error(
      `This is a Netlify build, but VITE_BACKEND is "${backend}" (Vite mode "${mode}"). A hosted site is static ` +
        `files: it can never reach a MedHop backend on anyone's computer, so a Python build would show nothing ` +
        `but "not connected". Build it with "npm run build:browser" (vite build --mode browser), which runs the ` +
        `simulator inside the page.`,
    );
  }
  return {
    plugins: [react()],
    // Always a string literal in the code, so the build drops the side of each VITE_BACKEND check that this
    // build does not use (the other transport is not in the bundle at all).
    define: { "import.meta.env.VITE_BACKEND": JSON.stringify(backend) },
    server: {
      port: 5180,
      strictPort: true,
    },
    preview: {
      port: 5180,
      strictPort: true,
    },
    test: {
      include: ["src/**/*.test.ts"],
      environment: "node",
    },
  };
});
