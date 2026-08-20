import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RadioProgressBar } from "./RadioProgressBar";

afterEach(cleanup);

describe("RadioProgressBar", () => {
	it("derives the slider value from currentTime / duration", () => {
		const { container } = render(
			<RadioProgressBar currentTime={30} duration={120} onSeekPct={() => {}} />,
		);
		const input = container.querySelector("input") as HTMLInputElement;
		expect(input.value).toBe("0.25");
	});

	it("shows 0 and does not divide by zero when duration is 0", () => {
		const { container } = render(
			<RadioProgressBar currentTime={5} duration={0} onSeekPct={() => {}} />,
		);
		const input = container.querySelector("input") as HTMLInputElement;
		expect(input.value).toBe("0");
	});

	it("formats an elapsed / total readout", () => {
		const { getByText } = render(
			<RadioProgressBar currentTime={65} duration={125} onSeekPct={() => {}} />,
		);
		expect(getByText("0:01:05 / 0:02:05")).not.toBeNull();
	});

	it("announces the elapsed/total position via aria-valuetext", () => {
		const { container } = render(
			<RadioProgressBar currentTime={65} duration={125} onSeekPct={() => {}} />,
		);
		const input = container.querySelector("input") as HTMLInputElement;
		expect(input.getAttribute("aria-valuetext")).toBe("0:01:05 of 0:02:05");
	});

	it("reports the dragged fraction through onSeekPct", () => {
		const onSeekPct = vi.fn();
		const { container } = render(
			<RadioProgressBar currentTime={0} duration={100} onSeekPct={onSeekPct} />,
		);
		const input = container.querySelector("input") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "0.5" } });
		expect(onSeekPct).toHaveBeenCalledWith(0.5);
	});
});
