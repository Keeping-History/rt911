import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
	MediaStreamContext,
	type MediaStreamContextValue,
} from "../../../Providers/MediaStream/MediaStreamContext";

vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyWindow: ({ children, id, title }: { children?: ReactNode; id?: string; title?: string }) => (
		<div data-testid={`win-${id}`} data-title={title}>
			{children}
		</div>
	),
}));

import { FlightMapPicker } from "./FlightMapPicker";

afterEach(cleanup);

const POSITIONS = [
	{ id: 1, flight: "AA11", carrier: "American", start_date: "x", lat: 42, lon: -71, alt_ft: 30000 },
	{ id: 2, flight: "DAL123", start_date: "x", lat: 40, lon: -75, alt_ft: 35000 },
];

function renderPicker(flightPositions: unknown[], onChange = vi.fn()) {
	const ctx = {
		flightPositions,
		subscribeFlights: vi.fn(),
		unsubscribeFlights: vi.fn(),
	} as unknown as MediaStreamContextValue;
	render(
		<MediaStreamContext.Provider value={ctx}>
			<FlightMapPicker value={[]} onChange={onChange} />
		</MediaStreamContext.Provider>,
	);
	return ctx;
}

describe("FlightMapPicker", () => {
	it("subscribes to the flight channel on mount", () => {
		const ctx = renderPicker(POSITIONS);
		expect(ctx.subscribeFlights).toHaveBeenCalledTimes(1);
	});

	it("lists every flight currently on the map, with carrier when known", async () => {
		renderPicker(POSITIONS);
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		expect(await screen.findByLabelText("AA11 (American)")).toBeTruthy();
		expect(screen.getByLabelText("DAL123")).toBeTruthy();
	});

	it("shows an empty-state message with nothing on the map", async () => {
		renderPicker([]);
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		expect(await screen.findByText("No flights are currently on the map.")).toBeTruthy();
	});

	it("confirms the selected callsigns", async () => {
		const onChange = vi.fn();
		renderPicker(POSITIONS, onChange);
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		fireEvent.click(await screen.findByLabelText("AA11 (American)"));
		fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
		expect(onChange).toHaveBeenCalledWith(["AA11"]);
	});

	it("filters to notable flights only via the checkbox", async () => {
		renderPicker(POSITIONS);
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		await screen.findByLabelText("AA11 (American)");
		fireEvent.click(screen.getByLabelText("Notable flights only"));
		await screen.findByLabelText("AA11 (American)");
		expect(screen.queryByLabelText("DAL123")).toBeNull();
	});

	it("does not call onChange on Cancel", async () => {
		const onChange = vi.fn();
		renderPicker(POSITIONS, onChange);
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		await screen.findByLabelText("AA11 (American)");
		act(() => {
			fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
		});
		expect(onChange).not.toHaveBeenCalled();
	});
});
