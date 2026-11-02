import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm --filter @turtle/web dev` proxies the API to a running `turtle ui --port 4317`.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1000 },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:4317", headers: { host: "127.0.0.1:4317" } },
    },
  },
});
