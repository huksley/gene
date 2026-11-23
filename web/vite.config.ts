/**
 * The web UI (GENE_UI_PORT): a React + Tailwind + shadcn/ui page built into ONE
 * self-contained HTML file (vite-plugin-singlefile), so the daemon can serve it
 * straight from a single SEA asset — no static dir to ship. `pnpm run build:ui`
 * writes dist/ui/index.html; `pnpm run dev:ui` serves it with HMR and proxies /api to
 * a running daemon (GENE_UI_PORT, default 8474).
 */
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const daemonPort = process.env.GENE_UI_PORT ?? process.env.UI_PORT ?? "8474";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: {
    outDir: path.resolve(import.meta.dirname, "../dist/ui"),
    emptyOutDir: true,
    reportCompressedSize: false
  },
  server: {
    proxy: { "/api": `http://127.0.0.1:${daemonPort}` }
  }
});
