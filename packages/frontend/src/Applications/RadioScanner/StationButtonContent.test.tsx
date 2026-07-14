import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

// rt911 has no global test setup, so testing-library does not auto-clean the
// DOM between tests; do it explicitly to keep document-level queries isolated.
afterEach(cleanup);

import { StationButtonContent } from "./StationButtonContent";

describe("StationButtonContent", () => {
	it("renders the station label", () => {
		const { getByText } = render(<StationButtonContent label="NY ATC" offline={false} />);
		expect(getByText("NY ATC")).not.toBeNull();
	});

	it("shows the lit indicator while the station is online", () => {
		const { getByAltText, queryByAltText } = render(
			<StationButtonContent label="NY ATC" offline={false} />,
		);
		const light = getByAltText("On air") as HTMLImageElement;
		expect(light.src).toContain("light-on");
		expect(queryByAltText("Offline")).toBeNull();
	});

	it("shows the unlit indicator while the station is offline", () => {
		const { getByAltText, queryByAltText } = render(
			<StationButtonContent label="NY ATC" offline={true} />,
		);
		const light = getByAltText("Offline") as HTMLImageElement;
		expect(light.src).toContain("light-off");
		expect(queryByAltText("On air")).toBeNull();
	});
});
