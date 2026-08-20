import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

// rt911 has no global test setup, so testing-library does not auto-clean the
// DOM between tests; do it explicitly to keep document-level queries isolated.
afterEach(cleanup);

import { StationButtonContent } from "./StationButtonContent";

describe("StationButtonContent", () => {
	it("renders the station label", () => {
		const { getByText } = render(<StationButtonContent label="NY ATC" status="on-air" />);
		expect(getByText("NY ATC")).not.toBeNull();
	});

	it("shows the lit indicator while the station is on air", () => {
		const { getByAltText, queryByAltText } = render(
			<StationButtonContent label="NY ATC" status="on-air" />,
		);
		const light = getByAltText("On air") as HTMLImageElement;
		expect(light.src).toContain("light-on");
		expect(queryByAltText("Offline")).toBeNull();
		expect(queryByAltText("Upcoming")).toBeNull();
	});

	it("shows the upcoming indicator while the station only has queued items", () => {
		const { getByAltText, queryByAltText } = render(
			<StationButtonContent label="NY ATC" status="upcoming" />,
		);
		const light = getByAltText("Upcoming") as HTMLImageElement;
		expect(light.src).toContain("light-upcoming");
		expect(queryByAltText("On air")).toBeNull();
		expect(queryByAltText("Offline")).toBeNull();
	});

	it("shows the unlit indicator while the station is offline", () => {
		const { getByAltText, queryByAltText } = render(
			<StationButtonContent label="NY ATC" status="offline" />,
		);
		const light = getByAltText("Offline") as HTMLImageElement;
		expect(light.src).toContain("light-off");
		expect(queryByAltText("On air")).toBeNull();
		expect(queryByAltText("Upcoming")).toBeNull();
	});
});
