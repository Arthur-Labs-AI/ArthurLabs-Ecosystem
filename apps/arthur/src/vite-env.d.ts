/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Tauri target platform of this build (linux, windows, android, ...). Unset outside Tauri. */
  readonly TAURI_ENV_PLATFORM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
