import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig, type Plugin } from "vite";
import { pagesRouteSlug } from "./src/Pages/route";

/**
 * COOP/COEP exist so the Infinite Mac emulator can use SharedArrayBuffer. They
 * are cross-origin isolation headers, and COEP blocks third-party iframes:
 * verified against the dev server, a YouTube embed fails with
 * ERR_BLOCKED_BY_RESPONSE while COEP is set and loads (200) the moment it is
 * removed.
 *
 * The emulator only ever runs on the desktop, which is served at `/`. CMS pages
 * are served at their own root-level slugs and must be able to embed video, so
 * they are served without the headers. Mirrors the `location` split in
 * nginx.conf — change both together or dev and production will disagree about
 * whether embeds work.
 */
function crossOriginIsolationExceptPages(): Plugin {
	return {
		name: "rt911-coop-coep-except-pages",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const pathname = (req.url ?? "/").split("?")[0];
				if (pagesRouteSlug(pathname) === null) {
					res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
					res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
				}
				next();
			});
		},
	};
}

// https://vite.dev/config/
export default defineConfig({
	plugins: [react(), crossOriginIsolationExceptPages()],
	server: {
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
