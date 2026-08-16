// Relative on purpose: requests go through Vite's dev-server proxy (see vite.config.ts) rather
// than straight to the Python server, so this works whether the page was opened as
// https://localhost:5173 or from another device on the LAN (https://<lan-ip>:5173) without
// hitting CORS or mixed-content (HTTPS page fetching a plain-HTTP server) errors.
export const OMR_SERVER_BASE_URL = "";
