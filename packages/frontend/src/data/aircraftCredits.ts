/**
 * Vendored copy of https://files.911realtime.org/maps/aircraft/models.json
 * (the manifest sitting beside the STLs the Flight Tracker fetches), plus the
 * WTC hero entry from Applications/FlightTracker/HERO_MODELS_CREDITS.md.
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

export const WTC_HERO_CREDIT: ModelCredit = {
	model: "World Trade Center complex (1974–2001)",
	author: "NanoRay",
	license: "CC-BY 4.0",
	url: "https://sketchfab.com/3d-models/world-trade-center-673f0ab7f31e4d878fb2c7920cea0ec5",
	note: "Decimated, reoriented and scaled to the true tower height — a derivative work, attribution retained per CC-BY.",
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
		note: "FlightGear FGAddon; converted from AC3D to STL locally via ac2stl.py; the derivative remains GPL.",
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
		note: "Converted from OBJ to STL locally via obj2stl.py; the derivative remains GPL-2.0.",
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
