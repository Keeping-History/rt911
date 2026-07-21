// scripts/load-map-pois.mjs
//
// Idempotent seed of the Directus `map_pois` collection (schema + public read +
// airport rows). Run ONCE with admin creds:
//   DIRECTUS_URL=https://api-beta.911realtime.org DIRECTUS_TOKEN=<admin> node scripts/load-map-pois.mjs
//
// Notes (from prior Directus schema work):
//  - the `details` field is created with special ["cast-json"] or reads 400.
//  - public read is granted via a policy (Directus 12), created if absent.
//  - schema-op bursts can wedge introspection; this creates fields serially and
//    prints a reminder to restart rt911-api if a later step 500s.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const URL = process.env.DIRECTUS_URL;
const TOKEN = process.env.DIRECTUS_TOKEN;
if (!URL || !TOKEN) { console.error("set DIRECTUS_URL and DIRECTUS_TOKEN"); process.exit(1); }

const dir = dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(readFileSync(join(dir, "map_pois.airports.json"), "utf8"));
const overlay = JSON.parse(readFileSync(join(dir, "map_pois.airports.overlay.json"), "utf8"));

const api = async (method, path, body) => {
	const res = await fetch(`${URL}${path}`, {
		method,
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!res.ok && res.status !== 404) {
		const text = await res.text();
		throw new Error(`${method} ${path} → ${res.status}: ${text}`);
	}
	return res.status === 404 ? null : res.json().catch(() => null);
};

async function ensureCollection() {
	const existing = await api("GET", "/collections/map_pois");
	if (existing) { console.log("collection map_pois exists"); return; }
	console.log("creating collection map_pois…");
	await api("POST", "/collections", {
		collection: "map_pois",
		schema: { name: "map_pois" },
		meta: { icon: "place", note: "Map points of interest (airports, etc.)" },
	});
	// Fields (serial — avoid wedging introspection). id is auto-created.
	const fields = [
		{ field: "name", type: "string", meta: { required: true } },
		{ field: "layer", type: "string", meta: { required: true } },
		{ field: "category", type: "string", meta: { required: true } },
		{ field: "detail_title", type: "string" },
		{ field: "lat", type: "float", meta: { required: true } },
		{ field: "lon", type: "float", meta: { required: true } },
		{ field: "iata", type: "string" },
		{ field: "icao", type: "string" },
		{ field: "city", type: "string" },
		{ field: "region", type: "string" },
		{ field: "details", type: "json", meta: { special: ["cast-json"] } },
		{ field: "sort", type: "integer" },
	];
	for (const f of fields) {
		console.log(`  + field ${f.field}`);
		await api("POST", "/fields/map_pois", f);
	}
}

async function ensurePublicRead() {
	// Directus 12: public access is policy-based. Anonymous reads only work if a
	// read permission is attached to the system Public policy's id (its name
	// resolves via the translation key $t:public_label) — permission.policy: null
	// is a stale Directus-9 (role: null) pattern and does NOT grant public access.
	const policies = await api("GET", "/policies?filter[name][_eq]=$t:public_label&fields=id");
	const publicPolicyId = policies?.data?.[0]?.id;
	if (!publicPolicyId) {
		console.error("!!! COULD NOT RESOLVE THE DIRECTUS PUBLIC POLICY ID — automated public-read grant NOT performed.");
		console.error("!!! You must grant it manually: Directus Admin UI → Settings → Access Policies → Public →");
		console.error("!!! Permissions → map_pois → Read. Until this is done, anonymous reads on map_pois will 403.");
		return;
	}
	const existing = await api(
		"GET",
		`/permissions?filter[collection][_eq]=map_pois&filter[action][_eq]=read&filter[policy][_eq]=${publicPolicyId}`,
	);
	if (existing?.data?.length) { console.log("public read already granted"); return; }
	console.log("granting public read on map_pois…");
	await api("POST", "/permissions", { collection: "map_pois", action: "read", policy: publicPolicyId, fields: ["*"] });
}

async function upsertRows() {
	// Key on (category, iata) so re-runs update instead of duplicating.
	for (const rec of base) {
		const details = { ...(rec.details ?? {}), ...(overlay[rec.iata] ?? {}) };
		const row = { ...rec, details };
		const found = await api(
			"GET",
			`/items/map_pois?filter[category][_eq]=${encodeURIComponent(rec.category)}&filter[iata][_eq]=${encodeURIComponent(rec.iata)}&fields=id&limit=1`,
		);
		const id = found?.data?.[0]?.id;
		if (id) await api("PATCH", `/items/map_pois/${id}`, row);
		else await api("POST", "/items/map_pois", row);
	}
	console.log(`upserted ${base.length} airport POIs`);
}

try {
	await ensureCollection();
	await ensurePublicRead();
	await upsertRows();
	console.log("done. If public reads still 403/400: (1) restart rt911-api to clear its introspection cache and re-check, and");
	console.log("(2) confirm the map_pois Read permission is attached to the Public policy in Settings → Access Policies → Public.");
} catch (err) {
	console.error(err.message);
	console.error("If this was a schema 500, restart rt911-api and re-run (idempotent). If public reads still fail after that,");
	console.error("the map_pois Read permission may not be attached to the Public policy — grant it manually in the Admin UI");
	console.error("(Settings → Access Policies → Public → Permissions → map_pois → Read) and re-run this script to verify.");
	process.exit(1);
}
