import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { HyperCardPartProps } from "classicy";
import {
	MediaStreamContext,
	type MediaStreamContextValue,
} from "../../../Providers/MediaStream/MediaStreamContext";

vi.mock("classicy", () => ({
	useClassicyDateTime: () => ({ dateTime: "2001-09-11T12:46:00.000Z" }),
	ClassicyControlGroup: ({ label, children }: { label?: string; children?: ReactNode }) => (
		<div>
			<span>{label}</span>
			{children}
		</div>
	),
}));

import { DirectusWeatherPart } from "./DirectusWeatherPart";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function renderPart(options: Record<string, unknown>, obs?: Record<string, unknown>) {
	// Almanac is fetched from the network; keep it absent in tests.
	vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 404 } as Response);
	const ctx = {
		weatherObservations: obs ? { KJFK: obs } : {},
		weatherForecastByZone: {},
		subscribeWeather: vi.fn(),
		unsubscribeWeather: vi.fn(),
		requestWeatherForecast: vi.fn(),
	} as unknown as MediaStreamContextValue;
	render(
		<MediaStreamContext.Provider value={ctx}>
			<DirectusWeatherPart {...partProps(options)} />
		</MediaStreamContext.Provider>,
	);
	return ctx;
}

describe("DirectusWeatherPart", () => {
	it("renders the requested station's conditions", () => {
		renderPart(
			{ station: "KJFK" },
			{ id: 1, station_id: "KJFK", start_date: "2001-09-11T12:46:00Z", temp_c: 20 },
		);
		// 20°C → 68°F via cToF, rendered in the Conditions group.
		expect(screen.getByText("68°F")).toBeTruthy();
		expect(screen.getByText("Conditions")).toBeTruthy();
	});

	it("defaults to KJFK when no station option is given", () => {
		renderPart(
			{},
			{ id: 1, station_id: "KJFK", start_date: "2001-09-11T12:46:00Z", temp_c: 0 },
		);
		expect(screen.getByText("32°F")).toBeTruthy();
	});

	it("subscribes to the weather channel on mount", () => {
		const ctx = renderPart({ station: "KJFK" });
		expect(ctx.subscribeWeather).toHaveBeenCalledTimes(1);
	});
});

function partProps(options: Record<string, unknown>): HyperCardPartProps {
	return {
		part: { id: "p", type: "directusWeatherStation" },
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
