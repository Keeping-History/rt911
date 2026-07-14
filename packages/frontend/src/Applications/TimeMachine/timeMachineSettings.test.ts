import type { ClassicyStore } from "classicy";
import { describe, expect, it } from "vitest";
import {
	classicyTimeMachineEventHandler,
	DEFAULT_TIME_MACHINE_SETTINGS,
	readTimeMachineSettings,
	timeMachineSetSettings,
} from "./timeMachineSettings";

describe("readTimeMachineSettings", () => {
	it("returns defaults for absent app data", () => {
		expect(readTimeMachineSettings(undefined)).toEqual({
			skipMinutes: 30,
			stepSeconds: 300,
		});
	});

	it("merges partial stored settings over defaults (no migration needed)", () => {
		expect(readTimeMachineSettings({ settings: { skipMinutes: 15 } })).toEqual({
			...DEFAULT_TIME_MACHINE_SETTINGS,
			skipMinutes: 15,
		});
	});

	it("falls back to defaults for non-finite or out-of-range stored values", () => {
		expect(
			readTimeMachineSettings({
				settings: { skipMinutes: Number.NaN, stepSeconds: -5 },
			}),
		).toEqual(DEFAULT_TIME_MACHINE_SETTINGS);
		expect(
			readTimeMachineSettings({
				settings: { skipMinutes: 999, stepSeconds: 999_999 },
			}),
		).toEqual(DEFAULT_TIME_MACHINE_SETTINGS);
	});
});

describe("timeMachineSetSettings", () => {
	it("builds the namespaced action", () => {
		const s = { skipMinutes: 10, stepSeconds: 60 };
		expect(timeMachineSetSettings(s)).toEqual({
			type: "ClassicyAppTimeMachineSetSettings",
			settings: s,
		});
	});
});

describe("classicyTimeMachineEventHandler", () => {
	function store(data: Record<string, unknown> | undefined): ClassicyStore {
		return {
			System: {
				Manager: {
					Applications: { apps: { "TimeMachine.app": { data } } },
				},
			},
		} as unknown as ClassicyStore;
	}

	it("writes settings without clobbering other app data", () => {
		const ds = store({ somethingElse: 42 });
		const next = classicyTimeMachineEventHandler(
			ds,
			timeMachineSetSettings({ skipMinutes: 5, stepSeconds: 120 }),
		);
		const data = next.System.Manager.Applications.apps["TimeMachine.app"]
			.data as Record<string, unknown>;
		expect(data.somethingElse).toBe(42);
		expect(data.settings).toEqual({ skipMinutes: 5, stepSeconds: 120 });
	});

	it("ignores unknown actions and a missing app entry", () => {
		const ds = store({ keep: 1 });
		expect(classicyTimeMachineEventHandler(ds, { type: "SomethingElse" })).toBe(ds);
		const empty = {
			System: { Manager: { Applications: { apps: {} } } },
		} as unknown as ClassicyStore;
		expect(
			classicyTimeMachineEventHandler(
				empty,
				timeMachineSetSettings(DEFAULT_TIME_MACHINE_SETTINGS),
			),
		).toBe(empty);
	});
});
