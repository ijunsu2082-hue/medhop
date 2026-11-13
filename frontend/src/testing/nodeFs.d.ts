// Minimal typing for the Node APIs the guard tests use: the app tsconfig loads only vite/client types,
// and Vitest hands CSS imports (even ?raw) to its CSS pipeline, which returns an empty string.
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
  export function readdirSync(path: string | URL, options: { recursive: true }): string[];
}
