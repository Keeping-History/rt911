import type { ClassicyStore } from "classicy";
import { describe, expect, it } from "vitest";
import {
	classicyWeatherEventHandler,
	DEFAULT_WEATHER_LOOP_SETTINGS,
	readWeatherLoopSettings,
	weatherSetLoopSettings,
} from "./weatherLoopSettings";

describe("readWeatherLoopSettings", () => {
	it("returns defaults for absent app data", () => {
		expect(readWeatherLoopSettings(undefined)).toEqual({
			enabled: false,
			windowHours: 3,
			speed: 1800,
		});
	});

	it("merges partial stored settings over defaults (no migration needed)", () => {
		expect(readWeatherLoopSettings({ loopSettings: { enabled: true } })).toEqual({
			...DEFAULT_WEATHER_LOOP_SETTINGS,
			enabled: true,
		});
	});
});

describe("weatherSetLoopSettings", () => {
	it("builds the namespaced action", () => {
		const s = { ...DEFAULT_WEATHER_LOOP_SETTINGS, speed: 3600 as const };
		expect(weatherSetLoopSettings(s)).toEqual({
			type: "ClassicyAppWeatherSetLoopSettings",
			loopSettings: s,
		});
	});
});

describe("classicyWeatherEventHandler", () => {
	function store(data: Record<string, unknown> | undefined): ClassicyStore {
		return {
			System: {
				Manager: {
					Applications: { apps: { "Weather.app": { data } } },
				},
			},
		} as unknown as ClassicyStore;
	}

	it("writes loopSettings without clobbering other app data", () => {
		const ds = store({ somethingElse: 42 });
		const next = classicyWeatherEventHandler(
			ds,
			weatherSetLoopSettings({ ...DEFAULT_WEATHER_LOOP_SETTINGS, enabled: true }),
		);
		const data = next.System.Manager.Applications.apps["Weather.app"]
			.data as Record<string, unknown>;
		expect(data.somethingElse).toBe(42);
		expect(data.loopSettings).toEqual({
			...DEFAULT_WEATHER_LOOP_SETTINGS,
			enabled: true,
		});
	});

	it("ignores unknown actions and a missing app entry", () => {
		const ds = store({ keep: 1 });
		expect(classicyWeatherEventHandler(ds, { type: "SomethingElse" })).toBe(ds);
		const empty = {
			System: { Manager: { Applications: { apps: {} } } },
		} as unknown as ClassicyStore;
		expect(
			classicyWeatherEventHandler(
				empty,
				weatherSetLoopSettings(DEFAULT_WEATHER_LOOP_SETTINGS),
			),
		).toBe(empty);
	});
});
