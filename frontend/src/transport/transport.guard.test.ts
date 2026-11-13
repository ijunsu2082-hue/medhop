// Guards for the build-time backend switch (transport/index.ts), read from the sources:
// - the choice is one inline VITE_BACKEND check with two dynamic imports, and nothing can fall back to the other;
// - the in-page simulator (src/engine/) is reached only through transport/browser.ts (plus the scene drawing and
//   the landing page, which draw with its geometry), so a Python build carries none of it;
// - the Python backend's address appears only in transport/python.ts;
// - nothing that decides the backend reads storage or the URL.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "../testing/cssGuard";

const SRC = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, SRC), "utf8");
/** Every source file under src/ (test files left out), as paths relative to src/. */
const SOURCES = sourceFiles(SRC, [".ts", ".tsx"]);
const STYLESHEETS = sourceFiles(SRC, [".css"]);
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** The module specifiers a source imports: static, side-effect, re-export and dynamic imports. */
function importsOf(source: string): string[] {
  return [...withoutComments(source).matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
}

/** A relative specifier resolved to a path under src/, or null for a package import. */
function resolve(file: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const href = new URL(spec, new URL(file, SRC)).href;
  return href.startsWith(SRC.href) ? href.slice(SRC.href.length) : null;
}

/** The files under src/ that `file` imports (extension-less, as written). */
const importedPaths = (file: string) =>
  importsOf(read(file))
    .map((spec) => resolve(file, spec))
    .filter((p): p is string => p !== null);

describe("the import scanner", () => {
  it("finds every kind of import", () => {
    const sample = [
      'import { a } from "../engine/drone/sim";',
      'import type { B } from "./b";',
      'import "./side.css";',
      'export { c } from "../c";',
      'const d = await import("./d");',
      'const e = lazy(() => import("../engine/e"));',
      '// import { f } from "../engine/f";',
    ].join("\n");
    expect(importsOf(sample)).toEqual(["../engine/drone/sim", "./b", "./side.css", "../c", "./d", "../engine/e"]);
  });

  it("resolves relative to the importing file", () => {
    expect(resolve("components/video/CanvasFeed.tsx", "../../scene/SceneCanvas")).toBe("scene/SceneCanvas");
    expect(resolve("transport/browser.ts", "../engine/drone/sim")).toBe("engine/drone/sim");
    expect(resolve("transport/index.ts", "react")).toBeNull();
  });

  it("sees the app's sources", () => {
    expect(SOURCES).toEqual(
      expect.arrayContaining(["main.tsx", "transport/index.ts", "transport/python.ts", "transport/browser.ts", "api/client.ts"]),
    );
  });
});

describe("transport/index.ts", () => {
  const index = read("transport/index.ts");
  const code = withoutComments(index);

  it("has no catch, so a failed load is never answered with the other transport", () => {
    expect(/\bcatch\b/.test(index)).toBe(false);
  });

  it("chooses with one inline VITE_BACKEND check and two dynamic imports", () => {
    expect(code).toContain('import.meta.env.VITE_BACKEND === "browser"');
    expect(code.match(/import\.meta\.env\.VITE_BACKEND/g)).toHaveLength(1);
    expect(code.match(/import\("\.\/browser"\)/g)).toHaveLength(1);
    expect(code.match(/import\("\.\/python"\)/g)).toHaveLength(1);
    // Those two are the only imports of either side: a static one would put both into every bundle.
    expect(importsOf(code).filter((spec) => /^\.\/(?:browser|python)$/.test(spec))).toEqual(["./browser", "./python"]);
  });
});

describe("who may import what", () => {
  it("only transport/browser.ts, the engine itself, the scene and the landing page import from engine/", () => {
    const allowed = (file: string) =>
      file === "transport/browser.ts" ||
      file.startsWith("engine/") ||
      file.startsWith("scene/") ||
      file.startsWith("components/landing/");
    const offenders = SOURCES.filter((file) => !allowed(file)).flatMap((file) =>
      importedPaths(file)
        .filter((p) => p === "engine" || p.startsWith("engine/"))
        .map((p) => `${file} imports ${p}`),
    );
    expect(offenders).toEqual([]);
  });

  it("only transport/index.ts imports a transport implementation", () => {
    const offenders = SOURCES.filter((file) => file !== "transport/index.ts").flatMap((file) =>
      importedPaths(file)
        .filter((p) => /^transport\/(?:python|browser)(?:\.ts)?$/.test(p))
        .map((p) => `${file} imports ${p}`),
    );
    expect(offenders).toEqual([]);
  });

  it("nothing imports the old api/config module", () => {
    const offenders = SOURCES.filter((file) => importedPaths(file).some((p) => /^api\/config(?:\.ts)?$/.test(p)));
    expect(offenders).toEqual([]);
  });
});

describe("the Python backend's address", () => {
  const ADDRESS = "localhost" + ":8010";

  it("appears only in transport/python.ts (and api/config.ts, if it ever comes back)", () => {
    const allowed = new Set(["transport/python.ts", "api/config.ts"]);
    const offenders = [...SOURCES, ...STYLESHEETS].filter((file) => !allowed.has(file) && read(file).includes(ADDRESS));
    expect(offenders).toEqual([]);
    expect(read("transport/python.ts")).toContain(ADDRESS);
  });
});

describe("deciding the backend", () => {
  /** Reading the backend switch. vite-env.d.ts only declares its type. */
  const READS_SWITCH = /\bVITE_BACKEND\b/;
  const DECIDERS = SOURCES.filter((file) => file !== "vite-env.d.ts" && READS_SWITCH.test(withoutComments(read(file))));

  it("happens only in the transport, its build constant and the camera feed's build-time import", () => {
    expect(DECIDERS.sort()).toEqual(["components/VideoFeed.tsx", "transport/index.ts", "transport/kind.ts"]);
  });

  it("never reads storage or the URL", () => {
    const STORAGE_OR_URL = /\b(?:localStorage|sessionStorage|URLSearchParams)\b|location\s*\.\s*(?:search|hash)/;
    const files = new Set([
      ...DECIDERS,
      ...SOURCES.filter((file) => file.startsWith("transport/")),
      "main.tsx",
    ]);
    const offenders = [...files].filter((file) => STORAGE_OR_URL.test(read(file)));
    expect(offenders).toEqual([]);
    expect(STORAGE_OR_URL.test(readFileSync(new URL("../vite.config.ts", SRC), "utf8"))).toBe(false);
  });
});
