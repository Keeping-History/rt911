import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";
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

/**
 * Where the dev-server Directus proxy forwards to. Production by default —
 * there is no separate staging instance — but overridable from the shell so a
 * locally-run Directus can be targeted without editing this file.
 *
 * Deliberately NOT `VITE_`-prefixed: that prefix means "inlined into browser
 * code", and this value is only ever read here, in Node, at config time.
 */
const DIRECTUS_PROXY_TARGET = process.env.DIRECTUS_PROXY_TARGET ?? "https://api.911realtime.org";

/**
 * Re-bind an upstream `Set-Cookie` so a localhost server can hold it.
 *
 * Directus issues its session cookie with `Domain=.911realtime.org; Secure`.
 * The domain attribute alone makes the browser discard the cookie on
 * `localhost` — a cookie can only be scoped to the origin's own domain or a
 * parent of it. `Secure` is dropped too: Chrome and Firefox treat localhost as
 * a trustworthy origin and would accept it over plain http, but that is a
 * browser-specific allowance rather than a guarantee, and nothing is protected
 * by keeping it on a loopback connection.
 *
 * Everything else is passed through untouched. In particular `SameSite=Lax`
 * needs no change: once proxied the request is same-origin, which Lax already
 * permits — it was only ever the cross-site case that dropped the cookie.
 */
export function rebindCookieToLocalhost(cookie: string): string {
	return cookie
		.split(";")
		.filter((part) => {
			const attribute = part.trim().toLowerCase();
			return !attribute.startsWith("domain=") && attribute !== "secure";
		})
		.join(";");
}

/**
 * Proxy table shared by the dev server AND `vite preview`.
 *
 * Both serve the app from `localhost`, so both hit the same wall, and a fix
 * that only covered `vite dev` left `vite preview` unable to make ANY Directus
 * call — including anonymous reads. Defining this once means the two can't
 * drift.
 *
 * On the Directus entry: it is proxied so the browser sees Directus as
 * SAME-ORIGIN with the server. Reaching the real host from localhost is
 * impossible, and not for one reason — the deployed Directus carries all
 * three of:
 *
 *   CORS_ORIGIN              the product domains only. A request from
 *                            localhost comes back with no
 *                            Access-Control-Allow-Origin at all, so the
 *                            browser discards the response before app code
 *                            sees it. This applies to ANONYMOUS reads too, not
 *                            just credentialed ones — and a wildcard is
 *                            illegal for credentialed requests, so no single
 *                            server-side value would cover both.
 *   SESSION_COOKIE_DOMAIN    .911realtime.org — unstorable on localhost.
 *   SESSION_COOKIE_SAME_SITE lax — not sent on cross-site requests.
 *
 * Routing through the server's own origin sidesteps all three at once: a
 * same-origin request runs no CORS check, and the rewritten cookie above binds
 * to localhost. That is why this is a proxy and not an allow-list entry —
 * widening the deployed CORS/cookie config to admit localhost would mean
 * SameSite=None on the real session cookie, weakening production auth for
 * everyone to serve local development.
 *
 * Inert by default: reached only when VITE_DIRECTUS_URL=/directus, which is
 * set by `.env.development` (dev) or `.env.preview` (build --mode preview).
 * Unset, the app calls Directus directly and nothing hits this route.
 */
const localProxy: Record<string, ProxyOptions> = {
	"/feedback": {
		target: "http://localhost:8080",
		changeOrigin: true,
	},
	"/directus": {
		target: DIRECTUS_PROXY_TARGET,
		changeOrigin: true,
		rewrite: (requestPath) => requestPath.replace(/^\/directus/, ""),
		configure: (proxy) => {
			proxy.on("proxyRes", (proxyRes) => {
				const cookies = proxyRes.headers["set-cookie"];
				if (!cookies) return;
				proxyRes.headers["set-cookie"] = cookies.map(rebindCookieToLocalhost);
			});
		},
	},
};

// https://vite.dev/config/
export default defineConfig({
	plugins: [react(), crossOriginIsolationExceptPages()],
	server: { proxy: localProxy },
	// `vite preview` serves the built bundle, and a production-mode build bakes
	// the ABSOLUTE Directus URL — which localhost can't call. Pair this with
	// `vite build --mode preview` (see the preview:auth script) so the bundle
	// carries /directus and this proxy has something to answer.
	preview: { proxy: localProxy },
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
