import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import { FlightDetailPanel } from "./FlightDetailPanel";

afterEach(cleanup);

const sel: FlightPosition = {
	id: 1, flight: "AA11", carrier: "AA", start_date: "2001-09-11T12:30:00Z",
	lat: 42, lon: -73, alt_ft: 29000, phase: "cruise",
};

describe("FlightDetailPanel", () => {
	it("prompts when nothing is selected", () => {
		render(<FlightDetailPanel selected={null} track={null} loading={false} error={null} />);
		expect(screen.getByText(/select a flight/i)).toBeTruthy();
	});
	it("shows flight fields and route from the track", () => {
		render(
			<FlightDetailPanel selected={sel} loading={false} error={null}
				track={{ flight: "AA11", origin: "BOS", scheduled_dest: "LAX", landed_at: null, diverted: false, geometry: null, tail_number: null, aircraft_type: null, details: null }} />,
		);
		expect(screen.getByText("AA11")).toBeTruthy();
		expect(screen.getByText(/29,?000/)).toBeTruthy();
		expect(screen.getByText(/BOS/)).toBeTruthy();
		expect(screen.getByText(/LAX/)).toBeTruthy();
	});
	it("shows a track-unavailable note on error", () => {
		render(<FlightDetailPanel selected={sel} track={null} loading={false} error="Track unavailable" />);
		expect(screen.getByText(/track unavailable/i)).toBeTruthy();
	});
});
