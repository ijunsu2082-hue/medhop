/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Python backend (python builds only). */
  readonly VITE_API_BASE?: string;
  /** "browser" builds the in-page simulator; anything else talks to the Python backend. */
  readonly VITE_BACKEND?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
