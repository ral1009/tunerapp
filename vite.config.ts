import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// Proxied through Vite (server-side) rather than fetched directly by the browser: this makes
// OMR requests same-origin from the browser's point of view, which fixes two problems at once
// when the app is opened from another device on the LAN (Vite's `host: true` below serves it at
// e.g. https://192.168.x.x:5173, not just https://localhost:5173) --
// 1. CORS: a same-origin request needs no allowlist entry on the Python server at all.
// 2. Mixed content: the browser only ever talks HTTPS to the Vite origin; the plain-HTTP hop to
//    the FastAPI server happens in Vite's Node process, which browsers don't block.
const OMR_SERVER_PROXY_TARGET = "http://localhost:8000";

export default defineConfig({
  plugins: [basicSsl()],
  server: {
    https: true,
    host: true,
    proxy: {
      "/api": { target: OMR_SERVER_PROXY_TARGET, changeOrigin: true }
    }
  },
  preview: {
    https: true,
    host: true,
    proxy: {
      "/api": { target: OMR_SERVER_PROXY_TARGET, changeOrigin: true }
    }
  }
});