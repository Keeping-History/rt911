/**
 * Vendored copy of https://files.911realtime.org/maps/aircraft/models.json
 * (the manifest sitting beside the STLs the Flight Tracker fetches), plus the
 * NYC hero entry from ./FlightTracker/HERO_MODELS_CREDITS.md
 * (Applications/FlightTracker/HERO_MODELS_CREDITS.md relative to src/).
 *
 * Copied 2026-08-04. This is deliberately a copy, not a fetch, so the About
 * window works with no network. It can drift from the hosted manifest when a
 * model is added or replaced — refresh with:
 *
 *   curl -s https://files.911realtime.org/maps/aircraft/models.json | python3 -m json.tool
 *
 * These credits satisfy the attribution required by the models' CC-BY, CC-BY-SA
 * and GPL licenses. Do not delete an entry while its model is still shipped.
 */

export type ModelCredit = {
	/** What the model depicts, as the author titled it. */
	model: string;
	author: string;
	license: string;
	url: string;
	note?: string;
};

/**
 * Every shipped STL passes through process_models.py (see
 * scripts/aircraft-models/README.md's "Rebuilding from scratch" step 3):
 * auto-oriented, rescaled to the map layer's unit grid, and decimated by
 * vertex clustering to <=6k triangles. That makes each one a modified
 * derivative of its linked original, not a verbatim copy -- CC-BY 4.0
 * §3(a)(1)(B) requires indicating such modifications, and CC-BY-SA
 * derivatives must be offered under the same/compatible license with
 * recipients told so. Rendered once under the "3D models" heading rather
 * than repeated across every entry.
 */
export const AIRCRAFT_MODEL_DERIVATIVE_NOTICE =
	"All models are reoriented, rescaled and decimated to ≤6k triangles for rendering; each is a modified derivative of the linked original. Derivatives of CC-BY-SA originals are distributed under CC-BY-SA 3.0.";

export const NYC_90S_HERO_CREDIT: ModelCredit = {
	model: "New York In The 90's",
	author: "rorovera201305",
	license: "CC-BY 4.0",
	url: "https://skfb.ly/oSMBU",
	note: "\"New York In The 90's\" by rorovera201305 is licensed under Creative Commons Attribution (http://creativecommons.org/licenses/by/4.0/). Decimated (2.68M → 200k triangles via quadric-error simplification), recentered and rescaled to match the real World Trade Center towers' documented height and separation — a derivative work, attribution retained per CC-BY.",
};

export const AIRCRAFT_CREDITS: ModelCredit[] = [
	{
		model: "Airbus A320",
		author: "PHILdesign",
		license: "CC-BY 4.0",
		url: "https://www.thingiverse.com/thing:2203732",
		note: "Mirror: https://archive.org/details/thingiverse-2203732. Stands in for airframes with no family-specific model.",
	},
	{
		model: "Boeing 737-800",
		author: "Jonah Ashton (Jonahash)",
		license: "CC-BY 4.0",
		url: "https://www.thingiverse.com/thing:2426394",
		note: "Mirror: https://archive.org/details/thingiverse-2426394.",
	},
	{
		model: "Boeing 757-200 (converted from FlightGear AC3D)",
		author:
			"Liam Gathercole, Skyop, Isais Prestes; reworked by Juuso Tapaninen (FlightGear 757-200 AUTHORS)",
		license: "GPL-2.0+",
		url: "https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/757-200/",
		note: "FlightGear FGAddon; converted from AC3D to STL locally via ac2stl.py; the derivative remains GPL. Preferred form for modification (GPL-2.0 §3): the upstream FlightGear FGAddon AC3D source linked above, plus this repo's conversion tooling at scripts/aircraft-models/ (ac2stl.py, process_models.py).",
	},
	{
		model: "Boeing 767-300ER",
		author: "RTicknor (Thingiverse)",
		license: "CC-BY-SA 3.0",
		url: "https://www.thingiverse.com/thing:947061",
	},
	{
		model: "Boeing 777-300ER",
		author: "Jevan Yu (jyu, Thingiverse)",
		license: "CC-BY 4.0",
		url: "https://www.thingiverse.com/thing:1703733",
	},
	{
		model: "Boeing 727 (converted from OBJ)",
		author: "Bogdan Deac (yuppy)",
		license: "GPL-2.0",
		url: "https://www.thingiverse.com/thing:3452615",
		note: "Converted from OBJ to STL locally via obj2stl.py; the derivative remains GPL-2.0. Preferred form for modification (GPL-2.0 §3): the upstream Thingiverse OBJ source linked above, plus this repo's conversion tooling at scripts/aircraft-models/ (obj2stl.py, process_models.py).",
	},
	{
		model: "Boeing 717 (MD-95; stands in for DC-9/MD-80/MD-88/717 T-tail family)",
		author: "A. C. (Adcoff72)",
		license: "CC-BY 3.0",
		url: "https://www.thingiverse.com/thing:3319522",
		note: "zip LICENSE.txt lists CC-BY 3.0; the Internet Archive mirror's metadata lists CC-BY 4.0.",
	},
	{
		model: "McDonnell Douglas DC-10",
		author:
			"Reean24 (Thingiverse), derived from 'DC10' by manilov.ap (Sketchfab, CC-BY)",
		license: "CC-BY 4.0",
		url: "https://www.thingiverse.com/thing:5278513",
	},
	{
		model: "Airbus A319",
		author: "P6619 (Thingiverse)",
		license: "CC-BY-SA 3.0",
		url: "https://www.thingiverse.com/thing:173006",
	},
	{
		model: "Airbus A321",
		author: "P6619 (Thingiverse)",
		license: "CC-BY-SA 3.0",
		url: "https://www.thingiverse.com/thing:173007",
	},
	{
		model: "Bombardier CRJ-200",
		author: "Fredepo",
		license: "CC-BY 3.0",
		url: "https://www.thingiverse.com/thing:1308356",
		note: "zip LICENSE.txt lists CC-BY 3.0; the Internet Archive mirror's metadata lists CC-BY 4.0.",
	},
	{
		model: "Embraer ERJ-145XR 1/200",
		author: "RTicknor",
		license: "CC-BY 3.0",
		url: "https://www.thingiverse.com/thing:1727564",
		note: "zip LICENSE.txt lists CC-BY 3.0; the Internet Archive mirror's metadata lists CC-BY 4.0.",
	},
	{
		model:
			"Fairchild-Dornier 328JET (high-wing T-tail regional; jet engines, not props)",
		author: "A. C. (Adcoff72)",
		license: "CC-BY 3.0",
		url: "https://www.thingiverse.com/thing:3319511",
		note: "zip LICENSE.txt lists CC-BY 3.0; the Internet Archive mirror's metadata lists CC-BY 4.0.",
	},
	{
		model: "Gulfstream G550 1/200 (close to G-V/G-II silhouette)",
		author: "Giddi",
		license: "CC-BY 3.0",
		url: "https://www.thingiverse.com/thing:3315582",
		note: "zip LICENSE.txt lists CC-BY 3.0; the Internet Archive mirror's metadata lists CC-BY 4.0.",
	},
	{
		model: "Douglas DC-3",
		author: "pumpkinhead3d",
		license: "CC-BY 3.0",
		url: "https://www.thingiverse.com/thing:2733162",
	},
];
