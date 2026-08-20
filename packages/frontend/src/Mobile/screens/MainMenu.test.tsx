// packages/frontend/src/Mobile/screens/MainMenu.test.tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenNavContext } from "../WheelContext";
import { MainMenu } from "./MainMenu";

// Partial classicy mock — full replacement breaks on transitive imports.
// mockDateTimeLocked is mutated per-test (see PlaylistProvider.test.tsx).
let mockDateTimeLocked = false;
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<object>()),
	useAppManager: (sel: (s: unknown) => unknown) =>
		sel({
			System: {
				Manager: {
					DateAndTime: { dateTimeLocked: mockDateTimeLocked },
				},
			},
		}),
}));

afterEach(cleanup);
window.HTMLElement.prototype.scrollIntoView = vi.fn();

describe("MainMenu", () => {
	it("leaves Time Travel enabled while the clock is not forced", () => {
		mockDateTimeLocked = false;
		render(<MainMenu hasNowPlaying={false} />);
		expect(screen.getByText("Time Travel").closest("li")?.className).not.toContain(
			"disabled",
		);
	});

	it("disables the Time Travel entry while the clock is forced", () => {
		mockDateTimeLocked = true;
		render(<MainMenu hasNowPlaying={false} />);
		const item = screen.getByText("Time Travel").closest("li");
		expect(item?.className).toContain("disabled");
	});

	it("tapping Time Travel while forced does not navigate", () => {
		mockDateTimeLocked = true;
		const push = vi.fn();
		render(
			<ScreenNavContext.Provider value={{ push, pop: vi.fn() }}>
				<MainMenu hasNowPlaying={false} />
			</ScreenNavContext.Provider>,
		);
		fireEvent.click(screen.getByText("Time Travel"));
		expect(push).not.toHaveBeenCalled();
	});
});
