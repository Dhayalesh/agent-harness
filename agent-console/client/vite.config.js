import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

const serverDirectory = fileURLToPath(new URL("../server/", import.meta.url));

export default defineConfig(({ mode }) => {
  const serverEnv = loadEnv(mode, serverDirectory, "");
  const serverPort = serverEnv.PORT || "4000";
  const configuredHost = serverEnv.HOST || "127.0.0.1";
  const serverHost =
    configuredHost === "0.0.0.0" || configuredHost === "::"
      ? "127.0.0.1"
      : configuredHost;
  const apiTarget =
    serverEnv.API_PROXY_TARGET || "http://" + serverHost + ":" + serverPort;

  return {
    plugins: [react()],
    build: {
      // noVNC's rfb.js uses a top-level await (WebCodecs feature probe) that
      // Vite's default esbuild target (pre-dating it) rejects at build time.
      target: "esnext",
    },
    server: {
      port: 5173,
      // Keep the browser on one origin and follow the API address configured in
      // server/.env so changing PORT does not break local development.
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
