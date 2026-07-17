import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HyperCardPartProps } from "classicy";
import {
	MediaStreamContext,
	type MediaStreamContextValue,
} from "../../../Providers/MediaStream/MediaStreamContext";

// Mock the clock hook and the heavy WebGL FlightMap; capture what the part
// passes to the map.
vi.mock("classicy", () => ({
	useClassicyDateTime: () => ({
		localDate: new Date("2001-09-11T12:46:00.000Z"),
		tzOffset: 0,
		paused: false,
	}),
}));
const mapProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../../FlightTracker/FlightMap", () => ({
	FlightMap: (props: Record<string, unknown>) => {
		mapProps.push(props);
		return <div data-testid="flightmap" />;
	},
}));

import { DirectusFlightMapPart } from "./DirectusFlightMapPart";

afterEach(() => {
	cleanup();
	mapProps.length = 0;
});

const POS = [
	{ id: 1, flight: "AA11", start_date: "x", lat: 42, lon: -71, alt_ft: 30000 },
	{ id: 2, flight: "DAL123", start_date: "x", lat: 40, lon: -75, alt_ft: 35000 },
];

function renderPart(options: Record<string, unknown>, flightPositions = POS) {
	const ctx = {
		flightPositions,
		subscribeFlights: vi.fn(),
		unsubscribeFlights: vi.fn(),
	} as unknown as MediaStreamContextValue;
	return render(
		<MediaStreamContext.Provider value={ctx}>
			<DirectusFlightMapPart {...partProps(options)} />
		</MediaStreamContext.Provider>,
	);
}

const last = () => mapProps[mapProps.length - 1];

describe("DirectusFlightMapPart", () => {
	it("passes every position through by default", () => {
		renderPart({});
		expect((last().positions as unknown[]).length).toBe(2);
		expect(last().playing).toBe(true);
	});

	it("filters to the notable flights when notablesOnly is set", () => {
		renderPart({ notablesOnly: true });
		const positions = last().positions as Array<{ flight: string }>;
		expect(positions.map((p) => p.flight)).toEqual(["AA11"]);
	});

	it("defaults the map style and pin colors, overridable via options", () => {
		renderPart({ mapStyle: "radar", pinColor: "#123456" });
		expect(last().mapStyle).toBe("radar");
		expect(last().pinColor).toBe("#123456");
	});

	it("subscribes to the flight channel on mount", () => {
		const ctx = {
			flightPositions: [],
			subscribeFlights: vi.fn(),
			unsubscribeFlights: vi.fn(),
		} as unknown as MediaStreamContextValue;
		render(
			<MediaStreamContext.Provider value={ctx}>
				<DirectusFlightMapPart {...partProps({})} />
			</MediaStreamContext.Provider>,
		);
		expect(ctx.subscribeFlights).toHaveBeenCalledTimes(1);
	});
});

function partProps(options: Record<string, unknown>): HyperCardPartProps {
	return {
		part: { id: "p", type: "directusFlightMap" },
		partId: "p",
		stackId: "s",
		options,
		locked: false,
		value: "",
		setValue: vi.fn(),
		fire: vi.fn(),
		getVariable: vi.fn(),
		resolve: (e: string) => e,
	} as unknown as HyperCardPartProps;
}
