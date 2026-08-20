import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapCompass } from "./MapCompass";

afterEach(cleanup);

describe("MapCompass", () => {
	it("counter-rotates the needle with the map bearing", () => {
		render(<MapCompass bearing={45} onReset={() => {}} />);
		expect(screen.getByTestId("compass-needle").style.transform).toBe("rotate(-45deg)");
	});

	it("resets to north on click", () => {
		const onReset = vi.fn();
		render(<MapCompass bearing={120} onReset={onReset} />);
		fireEvent.click(screen.getByRole("button", { name: "Reset bearing to north" }));
		expect(onReset).toHaveBeenCalledOnce();
	});
});
