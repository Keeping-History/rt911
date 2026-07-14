import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WaveformVisualizer } from "./WaveformVisualizer";

// rt911 has no global test setup, so testing-library does not auto-clean the
// DOM between tests; do it explicitly to keep renders isolated.
afterEach(cleanup);

// audioEl={null} short-circuits the capture/canvas effect, so no AudioContext
// or canvas 2D context is needed under jsdom.
describe("WaveformVisualizer (controlled)", () => {
	it("labels the toggle button with the current mode", () => {
		const { getByText } = render(
			<WaveformVisualizer audioEl={null} mode="Radial" onCycleMode={() => {}} />,
		);
		expect(getByText("Radial")).toBeTruthy();
	});

	it("calls onCycleMode on button mouse-up instead of cycling locally", () => {
		const onCycleMode = vi.fn();
		const { getByText } = render(
			<WaveformVisualizer audioEl={null} mode="Bars" onCycleMode={onCycleMode} />,
		);
		fireEvent.mouseUp(getByText("Bars"));
		expect(onCycleMode).toHaveBeenCalledTimes(1);
		// Still shows the prop mode — the parent owns the state.
		expect(getByText("Bars")).toBeTruthy();
	});

	it("accepts a colors override without crashing", () => {
		const { getByText } = render(
			<WaveformVisualizer
				audioEl={null}
				mode="Wave"
				onCycleMode={() => {}}
				colors={{ bright: "#ff0000", dim: "#330000" }}
			/>,
		);
		expect(getByText("Wave")).toBeTruthy();
	});
});
