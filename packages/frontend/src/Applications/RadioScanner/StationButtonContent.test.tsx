import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// rt911 has no global test setup, so testing-library does not auto-clean the
// DOM between tests; do it explicitly to keep document-level queries isolated.
afterEach(cleanup);

// react-fast-marquee measures via ResizeObserver, which jsdom doesn't
// implement. The marquee is purely presentational here, so render children
// directly.
vi.mock("./marquee", () => ({
	default: ({ children }: { children?: React.ReactNode }) => <div data-testid="marquee">{children}</div>,
}));

// jsdom has no layout, so drive the fits/overflows decision from the tests
// instead of from real measurement (the hook has its own unit tests).
const overflow = vi.hoisted(() => ({ value: false }));
vi.mock("./useVerticalStackOverflow", () => ({
	useVerticalStackOverflow: () => ({
		containerRef: () => {},
		labelRef: () => {},
		extraRef: () => {},
		overflowing: overflow.value,
	}),
}));
beforeEach(() => {
	overflow.value = false;
});

import type React from "react";
import styles from "./RadioScanner.module.scss";
import { StationButtonContent } from "./StationButtonContent";

describe("StationButtonContent", () => {
	it("renders the station label", () => {
		const { getByText } = render(<StationButtonContent label="NY ATC" offline={false} />);
		expect(getByText("NY ATC")).not.toBeNull();
	});

	it("renders no marquee while the station is online", () => {
		const { queryByTestId, queryByText } = render(<StationButtonContent label="NY ATC" offline={false} />);
		expect(queryByTestId("marquee")).toBeNull();
		expect(queryByText("OFFLINE")).toBeNull();
	});

	it("renders the OFFLINE marquee while the station is offline", () => {
		const { getByTestId, getByText } = render(<StationButtonContent label="NY ATC" offline={true} />);
		expect(getByTestId("marquee")).not.toBeNull();
		expect(getByText("OFFLINE")).not.toBeNull();
	});

	it("stacks label and marquee while both fit (no row modifier)", () => {
		const { getByText } = render(<StationButtonContent label="NY ATC" offline={true} />);
		const container = getByText("NY ATC").parentElement;
		expect(container?.className).toContain(styles.rsStationBtnContent);
		expect(container?.className).not.toContain(styles.rsStationBtnContentRow);
	});

	it("switches to the row layout when the button is too short to stack", () => {
		overflow.value = true;
		const { getByText } = render(<StationButtonContent label="NY ATC" offline={true} />);
		const container = getByText("NY ATC").parentElement;
		expect(container?.className).toContain(styles.rsStationBtnContentRow);
	});
});
