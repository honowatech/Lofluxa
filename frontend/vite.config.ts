/// <reference types="vitest/config" />
import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// En développement, l'API FastAPI tourne sur localhost:8000 : le proxy évite toute configuration CORS.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.VITE_API_PROXY ?? "http://localhost:8000", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    // MapLibre GL pèse ~800 ko à lui seul ; il est isolé dans son propre fichier, chargé avec la première carte.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: { maplibre: ["maplibre-gl"] },
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
    testTimeout: 15000,
  },
});
