import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PeaksWaveform } from "./PeaksWaveform";

afterEach(cleanup);

describe("PeaksWaveform", () => {
	it("renders a canvas sized to the requested height", () => {
		const peaks = Array.from({ length: 480 }, (_, i) => [-i % 128, i % 128]);
		const { container } = render(<PeaksWaveform peaks={peaks} height={40} />);
		const canvas = container.querySelector("canvas");
		expect(canvas).not.toBeNull();
		expect(canvas!.height).toBe(40);
	});

	it("renders nothing when there are no peaks", () => {
		const { container } = render(<PeaksWaveform peaks={[]} height={40} />);
		// No jest-dom in this repo: assert absence directly rather than via
		// toBeEmptyDOMElement.
		expect(container.firstChild).toBeNull();
	});
});
