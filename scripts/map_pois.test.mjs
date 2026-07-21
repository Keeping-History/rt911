// scripts/map_pois.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(readFileSync(join(dir, "map_pois.airports.json"), "utf8"));
const overlay = JSON.parse(readFileSync(join(dir, "map_pois.airports.overlay.json"), "utf8"));

assert(Array.isArray(base) && base.length > 0, "base must be a non-empty array");
const iatas = new Set();
for (const r of base) {
	assert(r.name && typeof r.name === "string", `record missing name: ${JSON.stringify(r)}`);
	assert(r.layer === "Major Airports", `bad layer: ${r.iata}`);
	assert(r.category === "airport", `bad category: ${r.iata}`);
	assert(Number.isFinite(r.lat) && Number.isFinite(r.lon), `bad coords: ${r.iata}`);
	assert(r.iata && /^[A-Z]{3}$/.test(r.iata), `bad iata: ${JSON.stringify(r)}`);
	assert(!iatas.has(r.iata), `duplicate iata: ${r.iata}`);
	iatas.add(r.iata);
}
for (const key of Object.keys(overlay)) {
	assert(iatas.has(key), `overlay key not in base: ${key}`);
}
console.log(`ok: ${base.length} airports, ${Object.keys(overlay).length} overlay entries`);
