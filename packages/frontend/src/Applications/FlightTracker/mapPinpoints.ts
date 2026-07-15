// Notable places of interest for the MapControls "Pinpoints" dropdown
// (issue #226). Curated center/zoom pairs — moderate zooms on purpose: the
// vector basemap tops out at z7 (overzoomed past that) and traffic context
// matters more than street-level framing. ~9.5 frames an airport and its
// approach corridors; the urban sites get ~10.5, Shanksville's rural crash
// area a wider 9.

export interface Pinpoint {
	id: string;
	label: string;
	center: [number, number]; // [lon, lat]
	zoom: number;
}

export const PINPOINTS: Pinpoint[] = [
	{ id: "logan", label: "Boston Logan", center: [-71.0096, 42.3656], zoom: 9.5 },
	{ id: "newark", label: "Newark International", center: [-74.1745, 40.6895], zoom: 9.5 },
	{ id: "dulles", label: "Washington Dulles", center: [-77.4565, 38.9531], zoom: 9.5 },
	{ id: "fidi", label: "NYC Financial District", center: [-74.0113, 40.7075], zoom: 10.5 },
	{ id: "pentagon", label: "The Pentagon", center: [-77.0563, 38.8719], zoom: 10.5 },
	{ id: "shanksville", label: "Shanksville, PA", center: [-78.9039, 40.0517], zoom: 9 },
];

export function pinpointById(id: string): Pinpoint | undefined {
	return PINPOINTS.find((p) => p.id === id);
}
