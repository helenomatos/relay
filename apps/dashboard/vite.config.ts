import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev, mirror the nginx routing used in Docker: /api -> API, /receiver -> chaos receiver.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3000", rewrite: (p) => p.replace(/^\/api/, "") },
      "/receiver": { target: "http://localhost:4000", rewrite: (p) => p.replace(/^\/receiver/, "") },
    },
  },
});
