import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API_PORT = Number(process.env.STONEHUSH_API_PORT ?? "3001");
const WEB_PORT = Number(process.env.STONEHUSH_WEB_PORT ?? "5173");

export default defineConfig(({ command }) => ({
  plugins: [tanstackRouter({ target: "react" }), react(), tailwindcss()],
  resolve:
    command === "serve"
      ? { conditions: ["development", "import", "module", "browser", "default"] }
      : {},
  server: {
    host: "127.0.0.1",
    port: WEB_PORT,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${API_PORT}`,
      },
      "/health": {
        target: `http://127.0.0.1:${API_PORT}`,
      },
    },
  },
}));
