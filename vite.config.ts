import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    // Firebase is an optional, lazy-loaded backend chunk; the interactive demo
    // and app shell stay below this threshold and do not download it.
    chunkSizeWarningLimit: 650,
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: process.env.CODEX_SANDBOX === "seatbelt"
      ? { useFsEvents: false, usePolling: true }
      : undefined,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
