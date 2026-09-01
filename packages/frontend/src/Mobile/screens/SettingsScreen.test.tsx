// packages/frontend/src/Mobile/screens/SettingsScreen.test.tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenNavContext } from "../WheelContext";
import { SettingsScreen } from "./SettingsScreen";

afterEach(cleanup);
window.HTMLElement.prototype.scrollIntoView = vi.fn();

describe("SettingsScreen", () => {
	it("navigates to the Color screen", () => {
		const push = vi.fn();
		render(
			<ScreenNavContext.Provider value={{ push, pop: vi.fn() }}>
				<SettingsScreen />
			</ScreenNavContext.Provider>,
		);
		fireEvent.click(screen.getByText("Color"));
		expect(push).toHaveBeenCalledWith("settingsColor");
	});
});
