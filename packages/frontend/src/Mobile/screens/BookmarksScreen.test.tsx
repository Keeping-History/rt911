// packages/frontend/src/Mobile/screens/BookmarksScreen.test.tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenNavContext } from "../WheelContext";

// vi.hoisted: imports (and vi.mock) hoist above plain consts — a bare const
// would hit a TDZ error when the mock factory runs during classicy's import.
const { setDateTime } = vi.hoisted(() => ({ setDateTime: vi.fn() }));
// Mutated per-test to drive the forced-clock write guard (see
// PlaylistProvider.test.tsx for the same mutable-mock convention).
let mockDateTimeLocked = false;
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<object>()),
	useClassicyDateTime: () => ({
		dateTime: "2001-09-11T12:40:00.000Z",
		paused: false,
		tzOffset: -4,
		setDateTime,
		pause: vi.fn(),
		resume: vi.fn(),
	}),
	useAppManager: (sel: (s: unknown) => unknown) =>
		sel({
			System: { Manager: { DateAndTime: { dateTimeLocked: mockDateTimeLocked } } },
		}),
}));
vi.mock("../../Applications/TimeMachine/useBookmarks", () => ({
	useBookmarks: () => ({
		global: [
			{ id: 1, title: "First impact", full_title: null, start_date: "2001-09-11T12:46:40" },
		],
		personal: [],
		loading: false,
		error: null,
		signedIn: false,
		addPersonal: vi.fn(),
		updatePersonalLocal: vi.fn(),
		removePersonalLocal: vi.fn(),
	}),
}));

import { BookmarksScreen } from "./BookmarksScreen";

afterEach(() => {
	cleanup();
	mockDateTimeLocked = false;
	setDateTime.mockClear();
});
window.HTMLElement.prototype.scrollIntoView = vi.fn();

describe("BookmarksScreen", () => {
	it("lists bookmarks with their local time", () => {
		render(<BookmarksScreen tzOffset={-4} />);
		expect(screen.getByText("First impact")).toBeTruthy();
		expect(screen.getByText("8:46:40 AM")).toBeTruthy();
	});

	it("activating a bookmark seeks the clock and pops back", () => {
		const pop = vi.fn();
		render(
			<ScreenNavContext.Provider value={{ push: vi.fn(), pop }}>
				<BookmarksScreen tzOffset={-4} />
			</ScreenNavContext.Provider>,
		);
		fireEvent.click(screen.getByText("First impact"));
		expect(setDateTime).toHaveBeenCalledWith(new Date("2001-09-11T12:46:40Z"));
		expect(pop).toHaveBeenCalled();
	});

	it("does not seek or pop when the clock is forced", () => {
		mockDateTimeLocked = true;
		const pop = vi.fn();
		render(
			<ScreenNavContext.Provider value={{ push: vi.fn(), pop }}>
				<BookmarksScreen tzOffset={-4} />
			</ScreenNavContext.Provider>,
		);
		fireEvent.click(screen.getByText("First impact"));
		expect(setDateTime).not.toHaveBeenCalled();
		expect(pop).not.toHaveBeenCalled();
	});
});
