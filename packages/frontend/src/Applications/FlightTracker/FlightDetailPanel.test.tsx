import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import type { FlightTrack } from "./useFlightTrack";
import { FlightDetailPanel } from "./FlightDetailPanel";

afterEach(cleanup);

const sel: FlightPosition = {
	id: 1, flight: "AA11", carrier: "AA", start_date: "2001-09-11T12:30:00Z",
	lat: 42, lon: -73, alt_ft: 29000, phase: "cruise",
};

const baseTrack: FlightTrack = {
	flight: "AA11", origin: "BOS", scheduled_dest: "LAX", landed_at: null,
	diverted: false, geometry: null,
	tail_number: null, aircraft_type: null, details: null,
	wheels_off_utc: null, wheels_on_utc: null,
};

const notableTrack: FlightTrack = {
	...baseTrack,
	tail_number: "N334AA",
	aircraft_type: "Boeing 767-223ER",
	details: {
		crew: { captain: "John Ogonowski", first_officer: "Thomas McGuinness", attendants: 9 },
		souls: { passengers: 76, crew: 11, hijackers: 5, total: 92 },
		hijackers: ["Mohamed Atta", "Abdulaziz al-Omari"],
		fate: { text: "Crashed into the North Tower of the World Trade Center", utc: "2001-09-11T12:46:40Z" },
	},
};

const PRE_IMPACT = Date.parse("2001-09-11T12:30:00Z");
const POST_IMPACT = Date.parse("2001-09-11T12:50:00Z");

describe("FlightDetailPanel", () => {
	it("prompts when nothing is selected", () => {
		render(<FlightDetailPanel selected={null} track={null} loading={false} error={null} nowMs={PRE_IMPACT} />);
		expect(screen.getByText(/select a flight/i)).toBeTruthy();
	});
	it("shows flight fields and route from the track", () => {
		render(<FlightDetailPanel selected={sel} loading={false} error={null} track={baseTrack} nowMs={PRE_IMPACT} />);
		expect(screen.getByText("AA11")).toBeTruthy();
		expect(screen.getByText(/29,?000/)).toBeTruthy();
		expect(screen.getByText(/BOS/)).toBeTruthy();
		expect(screen.getByText(/LAX/)).toBeTruthy();
	});
	it("shows a track-unavailable note on error", () => {
		render(<FlightDetailPanel selected={sel} track={null} loading={false} error="Track unavailable" nowMs={PRE_IMPACT} />);
		expect(screen.getByText(/track unavailable/i)).toBeTruthy();
	});
	it("shows aircraft type and tail when present", () => {
		render(<FlightDetailPanel selected={sel} loading={false} error={null}
			track={{ ...baseTrack, tail_number: "N334AA", aircraft_type: "Boeing 767-223ER" }} nowMs={PRE_IMPACT} />);
		expect(screen.getByText("Boeing 767-223ER")).toBeTruthy();
		expect(screen.getByText("N334AA")).toBeTruthy();
	});
	it("omits aircraft rows entirely when null — no placeholder dashes", () => {
		render(<FlightDetailPanel selected={sel} loading={false} error={null} track={baseTrack} nowMs={PRE_IMPACT} />);
		expect(screen.queryByText("Aircraft")).toBeNull();
		expect(screen.queryByText("Tail")).toBeNull();
	});
	it("renders crew, souls, and hijackers for a notable flight", () => {
		render(<FlightDetailPanel selected={sel} loading={false} error={null} track={notableTrack} nowMs={PRE_IMPACT} />);
		expect(screen.getByText("John Ogonowski")).toBeTruthy();
		expect(screen.getByText("Thomas McGuinness")).toBeTruthy();
		expect(screen.getByText(/76 passengers · 11 crew · 5 hijackers · 92 aboard/)).toBeTruthy();
		expect(screen.getByText(/Mohamed Atta, Abdulaziz al-Omari/)).toBeTruthy();
	});
	it("hides the fate line before the virtual clock reaches impact", () => {
		render(<FlightDetailPanel selected={sel} loading={false} error={null} track={notableTrack} nowMs={PRE_IMPACT} />);
		expect(screen.queryByText(/North Tower/)).toBeNull();
	});
	it("shows the fate line once the virtual clock passes impact", () => {
		render(<FlightDetailPanel selected={sel} loading={false} error={null} track={notableTrack} nowMs={POST_IMPACT} />);
		expect(screen.getByText(/North Tower/)).toBeTruthy();
	});
	it("shows heading in degrees when known, omits when null", () => {
		const { rerender } = render(
			<FlightDetailPanel selected={sel} loading={false} error={null} track={baseTrack} nowMs={PRE_IMPACT} headingDeg={271.6} />,
		);
		expect(screen.getByText("272°")).toBeTruthy();
		rerender(
			<FlightDetailPanel selected={sel} loading={false} error={null} track={baseTrack} nowMs={PRE_IMPACT} headingDeg={null} />,
		);
		expect(screen.queryByText("Heading")).toBeNull();
	});
	it("shows wheels-up in display time (tz-shifted)", () => {
		// 11:59Z at UTC-4 -> 7:59 AM
		render(
			<FlightDetailPanel selected={sel} loading={false} error={null} nowMs={PRE_IMPACT} tzOffset={-4}
				track={{ ...baseTrack, wheels_off_utc: "2001-09-11T11:59:00Z" }} />,
		);
		expect(screen.getByText("7:59 AM")).toBeTruthy();
	});
	it("marks wheels-down (est.) until the replay clock passes it, then plain", () => {
		const track = { ...baseTrack, wheels_on_utc: "2001-09-11T12:45:00Z" }; // 8:45 AM at -4
		const { rerender } = render(
			<FlightDetailPanel selected={sel} loading={false} error={null} nowMs={PRE_IMPACT} tzOffset={-4} track={track} />,
		);
		expect(screen.getByText("8:45 AM (est.)")).toBeTruthy();
		rerender(
			<FlightDetailPanel selected={sel} loading={false} error={null} nowMs={POST_IMPACT} tzOffset={-4} track={track} />,
		);
		expect(screen.getByText("8:45 AM")).toBeTruthy();
	});

	describe("position and leg-estimate rows (issue #227)", () => {
		it("shows the live position with hemisphere letters", () => {
			render(
				<FlightDetailPanel selected={sel} track={baseTrack} loading={false} error={null}
					nowMs={PRE_IMPACT} livePos={{ ...sel, lat: 40.7128, lon: -74.006 }} />,
			);
			expect(screen.getByText("Position")).toBeTruthy();
			expect(screen.getByText("40.71° N, 74.01° W")).toBeTruthy();
		});

		it("renders from-origin and to-dest rows from the estimates", () => {
			render(
				<FlightDetailPanel selected={sel} track={baseTrack} loading={false} error={null}
					nowMs={PRE_IMPACT} livePos={sel}
					estimates={{
						fromOrigin: { distanceNm: 152.4, elapsedMs: 31 * 60_000 },
						toDest: { distanceNm: 2010.2, etaMs: 4.5 * 3_600_000 },
					}} />,
			);
			expect(screen.getByText("From BOS")).toBeTruthy();
			expect(screen.getByText("152 nm · 31 m")).toBeTruthy();
			expect(screen.getByText("To LAX")).toBeTruthy();
			expect(screen.getByText("2010 nm · 4 h 30 m (est.)")).toBeTruthy();
		});

		it("shows distance without an ETA when speed is unknown; hides rows for null estimates", () => {
			const { rerender } = render(
				<FlightDetailPanel selected={sel} track={baseTrack} loading={false} error={null}
					nowMs={PRE_IMPACT}
					estimates={{ fromOrigin: null, toDest: { distanceNm: 500, etaMs: null } }} />,
			);
			expect(screen.queryByText("From BOS")).toBeNull();
			expect(screen.getByText("500 nm")).toBeTruthy();
			rerender(
				<FlightDetailPanel selected={sel} track={baseTrack} loading={false} error={null}
					nowMs={PRE_IMPACT} estimates={{ fromOrigin: null, toDest: null }} />,
			);
			expect(screen.queryByText("To LAX")).toBeNull();
		});
	});

	describe("multi-selection (issue #225)", () => {
		const other: FlightPosition = { ...sel, id: 2, flight: "DL404" };

		it("hides the selection row for a single-flight selection", () => {
			render(
				<FlightDetailPanel selected={sel} track={null} loading={false} error={null}
					nowMs={PRE_IMPACT} selectionOptions={[sel]} />,
			);
			expect(screen.queryByRole("combobox")).toBeNull();
			expect(screen.queryByText("Save as Filter")).toBeNull();
		});

		it("offers a dropdown across the selected flights and a save button", () => {
			const onPickFlight = vi.fn();
			const onSaveAsFilter = vi.fn();
			render(
				<FlightDetailPanel selected={sel} track={null} loading={false} error={null}
					nowMs={PRE_IMPACT} selectionOptions={[sel, other]}
					onPickFlight={onPickFlight} onSaveAsFilter={onSaveAsFilter} />,
			);
			// ClassicyPopUpMenu (>= 0.41.5) has no hidden native <select>: the
			// trigger is a role="button" showing the selected label, and picking
			// an option means opening the listbox then clicking the option.
			const trigger = document.getElementById("flight_detail_selection") as HTMLButtonElement;
			expect(trigger.textContent).toContain("AA11");
			fireEvent.click(trigger);
			fireEvent.click(screen.getByRole("option", { name: "DL404" }));
			expect(onPickFlight).toHaveBeenCalledWith("DL404");
			fireEvent.click(screen.getByText("Save as Filter"));
			expect(onSaveAsFilter).toHaveBeenCalledOnce();
		});
	});
});
