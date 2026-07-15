// Notable places of interest for the MapControls "Pinpoints" dropdown
// (issue #226). Curated center/zoom pairs — zoom ~12 frames an airport and its
// approaches; the tighter urban sites get ~13.5, Shanksville's rural crash
// area a wider 11.

export interface Pinpoint {
	id: string;
	label: string;
	center: [number, number]; // [lon, lat]
	zoom: number;
}

export const PINPOINTS: Pinpoint[] = [
	{ id: "logan", label: "Boston Logan", center: [-71.0096, 42.3656], zoom: 12 },
	{ id: "newark", label: "Newark International", center: [-74.1745, 40.6895], zoom: 12 },
	{ id: "dulles", label: "Washington Dulles", center: [-77.4565, 38.9531], zoom: 12 },
	{ id: "fidi", label: "NYC Financial District", center: [-74.0113, 40.7075], zoom: 13.5 },
	{ id: "pentagon", label: "The Pentagon", center: [-77.0563, 38.8719], zoom: 13.5 },
	{ id: "shanksville", label: "Shanksville, PA", center: [-78.9039, 40.0517], zoom: 11 },
];

export function pinpointById(id: string): Pinpoint | undefined {
	return PINPOINTS.find((p) => p.id === id);
}
