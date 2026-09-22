import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5288,
    strictPort: true,
    watch: {
      ignored: ["**/profiles/**", "**/data/**", "**/studiorelay/**"],
    },
    proxy: {
      "/api": "http://127.0.0.1:5176",
    },
  },
});
