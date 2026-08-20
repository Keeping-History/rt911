import type { HCAction, HCStack } from "classicy";

/**
 * A built-in HyperCard stack demonstrating the weather-station and flight-map
 * embeds. The flight map only shows planes when the clock sits in the 9/11
 * morning window, so the second card includes a setDateTime button.
 */

// Plugin-command actions are outside the typed HCAction union (see
// newsPagerStack.ts) — cast the setDateTime command back to HCAction.
const setDateTime = (to: string): HCAction =>
	({ do: "setDateTime", to }) as unknown as HCAction;

export const WEATHER_FLIGHT_STACK_ID = "directus-weather-flight";

export const weatherFlightStack: HCStack = {
	name: "Weather & Flights",
	version: "2",
	size: [420, 340],
	variables: { wxStation: "KJFK" },
	backgrounds: [
		{
			id: "main",
			parts: [
				{
					id: "footer",
					type: "label",
					shared: true,
					rect: [12, 312, 396, 20],
					content: "tv_channels weather stations + the flight map — Directus HyperCard extensions",
				},
			],
		},
	],
	cards: [
		{
			id: "weather",
			name: "Weather",
			background: "main",
			parts: [
				{
					id: "wxTitle",
					type: "label",
					rect: [12, 14, 396, 22],
					content: "Weather station",
				},
				{
					id: "wxPanel",
					// station resolves through the expression engine, so the buttons
					// below can switch it via the wxStation variable.
					type: "directusWeatherStation",
					rect: [12, 40, 396, 210],
					options: { station: "wxStation" },
				},
				{
					id: "wxJFK",
					type: "button",
					name: "JFK",
					rect: [12, 258, 74, 26],
					script: { onMouseUp: [{ do: "put", value: "KJFK", var: "wxStation" }] },
				},
				{
					id: "wxBOS",
					type: "button",
					name: "Boston",
					rect: [94, 258, 74, 26],
					script: { onMouseUp: [{ do: "put", value: "KBOS", var: "wxStation" }] },
				},
				{
					id: "wxIAD",
					type: "button",
					name: "Dulles",
					rect: [176, 258, 74, 26],
					script: { onMouseUp: [{ do: "put", value: "KIAD", var: "wxStation" }] },
				},
				{
					id: "wxNext",
					type: "button",
					name: "Flights →",
					rect: [304, 258, 104, 26],
					script: {
						onMouseUp: [
							{ do: "visual", effect: "dissolve" },
							{ do: "go", to: "next" },
						],
					},
				},
			],
		},
		{
			id: "flights",
			name: "Flights",
			background: "main",
			parts: [
				{
					id: "flTitle",
					type: "label",
					rect: [12, 14, 260, 22],
					content: "Notable flights, live",
				},
				{
					id: "flJump",
					type: "button",
					name: "Jump to 8:46 AM",
					rect: [276, 12, 132, 26],
					script: { onMouseUp: [setDateTime("2001-09-11T12:46:00")] },
				},
				{
					id: "flMap",
					type: "directusFlightMap",
					rect: [12, 44, 396, 206],
					options: { notablesOnly: true, mapStyle: "radar" },
				},
				{
					id: "flPrev",
					type: "button",
					name: "← Weather",
					rect: [12, 258, 104, 26],
					script: {
						onMouseUp: [
							{ do: "visual", effect: "wipeRight" },
							{ do: "go", to: "prev" },
						],
					},
				},
			],
		},
	],
};
