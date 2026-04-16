import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8"));

// IMPORTANT:
// - root must be "./client" so Vite can find client/index.html
// - base must be "./" so Electron file:// loads JS/CSS correctly
// - publicDir MUST be set so /assets/* works in Electron

export default defineConfig({
  root: path.resolve(__dirname, "client"),
  base: "./",

  publicDir: "public",

  plugins: [react()],

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client", "src"),
    },
  },

  build: {
    outDir: path.resolve(__dirname, "dist", "public"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "client", "index.html"),
        people: path.resolve(__dirname, "client", "people.html"),
      },
    },
  },

  server: {
    port: 5000,
    strictPort: true,
  },
});
