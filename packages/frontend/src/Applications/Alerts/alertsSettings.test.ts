import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getAlertsEnabled,
	resetAlertsSettingsForTests,
	setAlertsEnabled,
	useAlertsEnabled,
} from "./alertsSettings";

const KEY = "rt911AlertsEnabled";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	window.localStorage.clear();
	resetAlertsSettingsForTests();
});

describe("alertsSettings store", () => {
	it("defaults to enabled when localStorage has no value", () => {
		expect(getAlertsEnabled()).toBe(true);
	});

	it("hydrates disabled state from a persisted \"false\"", () => {
		window.localStorage.setItem(KEY, "false");
		resetAlertsSettingsForTests();
		expect(getAlertsEnabled()).toBe(false);
	});

	it("treats any value other than the literal \"false\" as enabled", () => {
		window.localStorage.setItem(KEY, "garbage");
		resetAlertsSettingsForTests();
		expect(getAlertsEnabled()).toBe(true);
	});

	it("setAlertsEnabled persists to localStorage and updates the getter", () => {
		setAlertsEnabled(false);
		expect(getAlertsEnabled()).toBe(false);
		expect(window.localStorage.getItem(KEY)).toBe("false");

		setAlertsEnabled(true);
		expect(getAlertsEnabled()).toBe(true);
		expect(window.localStorage.getItem(KEY)).toBe("true");
	});

	it("useAlertsEnabled re-renders subscribers when the flag flips", () => {
		const { result } = renderHook(() => useAlertsEnabled());
		expect(result.current).toBe(true);

		act(() => setAlertsEnabled(false));
		expect(result.current).toBe(false);

		act(() => setAlertsEnabled(true));
		expect(result.current).toBe(true);
	});

	it("falls back to enabled when localStorage reads throw (private-mode Safari)", () => {
		// window.localStorage in this test environment is an own-property
		// polyfill (see vitest.setup.ts), not a Storage.prototype instance, so
		// the spy must target the instance itself to actually intercept calls.
		const getItemSpy = vi
			.spyOn(window.localStorage, "getItem")
			.mockImplementation(() => {
				throw new Error("denied");
			});
		resetAlertsSettingsForTests();
		expect(getItemSpy).toHaveBeenCalledWith(KEY);
		expect(getAlertsEnabled()).toBe(true);
	});

	it("keeps working in-memory when localStorage writes throw", () => {
		const setItemSpy = vi
			.spyOn(window.localStorage, "setItem")
			.mockImplementation(() => {
				throw new Error("denied");
			});
		setAlertsEnabled(false);
		expect(setItemSpy).toHaveBeenCalledWith(KEY, "false");
		expect(getAlertsEnabled()).toBe(false);
	});
});
