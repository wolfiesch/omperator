import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const page = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        index: page("index.html"),
        docs: page("docs/index.html"),
        linux: page("linux.html"),
        notFound: page("404.html"),
      },
    },
  },
});
