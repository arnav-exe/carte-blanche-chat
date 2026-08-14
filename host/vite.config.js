import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
    plugins: [svelte(), tailwindcss()],
    build: { outDir: "dist" },
    server: { proxy: { "/api": "http://localhost:8000", "/img": "http://localhost:8000" } },  // vite dev against the fastapi backend
});
