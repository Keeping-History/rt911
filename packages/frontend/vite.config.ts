import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
	plugins: [react()],
	server: {
		headers: {
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Embedder-Policy": "credentialless",
		},
		proxy: {
			"/feedback": {
				target: "http://localhost:8080",
				changeOrigin: true,
			},
		},
	},
	build: {
		sourcemap: true,
		rollupOptions: {
			output: {
				// Isolate maplibre-gl (+ its pmtiles protocol) into its own chunk.
				// This is CORRECTNESS, not just code-splitting: maplibre-gl 5.x ships
				// only a prebuilt UMD bundle (no ESM entry), and when Rolldown (Vite 8)
				// scope-hoists it into the shared app chunk it mangles an internal
				// variable declaration — the reference survives (renamed T4/f) but its
				// binding is dropped, so maplibre throws "T4 is not defined" the moment
				// its source-error path runs (e.g. the Flight Tracker basemap 404s).
				// That ReferenceError aborts map load and no aircraft ever render — a
				// production-only break invisible in the dev server (unbundled maplibre).
				// Keeping maplibre in its own chunk preserves its IIFE scope and avoids
				// the mis-hoist. Do not fold this back into the main chunk.
				manualChunks(id) {
					if (id.includes("maplibre-gl") || id.includes("pmtiles")) return "maplibre";
				},
			},
		},
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: {
			react: path.resolve("./node_modules/react"),
			"react-dom": path.resolve("./node_modules/react-dom"),
		},
	},
	test: {
		environment: "jsdom",
		setupFiles: ["./vitest.setup.ts"],
		exclude: ["node_modules", "e2e/**"],
	},
});
