// Minimal typing for the one Node API the CSS guard tests use: the app tsconfig loads only vite/client types,
// and Vitest hands CSS imports (even ?raw) to its CSS pipeline, which returns an empty string.
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
}
