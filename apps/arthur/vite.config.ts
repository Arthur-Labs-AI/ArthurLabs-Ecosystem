import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

// Set by `tauri android dev` / `tauri ios dev` so a physical device can reach this server.
const devHost = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Tauri exposes TAURI_ENV_PLATFORM etc. to the frontend build; see client/index.ts.
  envPrefix: ["VITE_", "TAURI_ENV_"],
  resolve: {
    alias: {
      "@arthur/contracts": here("../../packages/contracts/index.ts"),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: devHost || false,
    hmr: devHost ? { protocol: "ws", host: devHost, port: 1421 } : undefined,
    fs: {
      // packages/contracts lives outside this project root.
      allow: [here("."), here("../../packages")],
    },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
