import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const proxy = { "/api": { target: "http://127.0.0.1:3000", rewrite: (p: string) => p.replace(/^\/api/, "") } };

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Petty",
        short_name: "Petty",
        description: "A ledger for cash kept in several places.",
        theme_color: "#2f6f4f",
        background_color: "#f5f3ef",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Single-file worker: no importScripts (a Trusted Types sink under the strict CSP).
        inlineWorkboxRuntime: true,
        // App shell only. API responses are never cached by the worker: ciphertext and
        // metadata live in IndexedDB under the app's own rules, not in the HTTP cache.
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/downloads\//],
        globPatterns: ["**/*.{js,css,html,svg,png}"],
        // The Clerk chunk (clerk-js bundled, PETTY-88) is above Workbox's 2 MiB default; it is precached like the rest.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [],
        // PETTY-144: a new worker takes over the open pages at once; main.tsx reloads them onto the new shell.
        clientsClaim: true,
        skipWaiting: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { proxy },
  preview: { proxy },
});
