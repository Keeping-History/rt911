import { describe, expect, it } from "vitest";
import {
	currentScreen,
	initialScreenStack,
	SCREEN_TITLES,
	screenStackReducer,
} from "./screenStack";

describe("screenStackReducer", () => {
	it("starts on the main menu", () => {
		expect(currentScreen(initialScreenStack)).toBe("menu");
	});

	it("push navigates forward, pop navigates back", () => {
		let s = screenStackReducer(initialScreenStack, { type: "push", id: "radio" });
		expect(currentScreen(s)).toBe("radio");
		s = screenStackReducer(s, { type: "push", id: "nowPlaying" });
		expect(currentScreen(s)).toBe("nowPlaying");
		s = screenStackReducer(s, { type: "pop" });
		expect(currentScreen(s)).toBe("radio");
	});

	it("pop at the root is a no-op", () => {
		const s = screenStackReducer(initialScreenStack, { type: "pop" });
		expect(s).toBe(initialScreenStack);
	});

	it("every screen has a status-bar title", () => {
		expect(SCREEN_TITLES.menu).toBe("iPod");
		for (const title of Object.values(SCREEN_TITLES)) {
			expect(title.length).toBeGreaterThan(0);
		}
	});

	it("has a title for the TV screen", () => {
		expect(SCREEN_TITLES.tv).toBe("TV");
	});
});
