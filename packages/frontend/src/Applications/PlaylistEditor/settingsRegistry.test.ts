// Exercises the REAL classicy manifest registry (no vi.mock), the same way
// appManifests.test.ts does: importing a context module runs its registerApp
// side effect.
import { registerApp } from "classicy";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import "../TV/TVContext";
import "../TimeMachine/timeMachineSettings";
import "../../Providers/Playlist/playlistStoreActions";

import { defaultValueFor, listSettingsApps, settingsFieldsOf } from "./settingsRegistry";

// A synthetic app covering the wrapper/enum cases no real schema exercises at
// top level. Registered once at module load; the registry is per test FILE
// (vitest isolates module instances), so this cannot leak into other suites.
registerApp({
	id: "FakeEnum.app",
	description: "Synthetic app for settingsRegistry tests.",
	state: z.looseObject({
		palette: z.enum(["warm", "cool"]).optional().describe("Color palette."),
		retries: z.number().default(3).optional(),
	}),
});

describe("listSettingsApps", () => {
	it("lists registered apps that declare a state schema, sorted by name", () => {
		const apps = listSettingsApps();
		const ids = apps.map((a) => a.appId);
		expect(ids).toContain("TV.app");
		expect(ids).toContain("TimeMachine.app");

		const names = apps.map((a) => a.name);
		expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
		expect(apps.find((a) => a.appId === "TimeMachine.app")?.name).toBe("Time Machine");
		// No curated name — prettified from the id.
		expect(apps.find((a) => a.appId === "FakeEnum.app")?.name).toBe("Fake Enum");
	});

	it("excludes apps without a state schema (PlaylistEditor itself)", () => {
		expect(listSettingsApps().map((a) => a.appId)).not.toContain("PlaylistEditor.app");
	});
});

describe("settingsFieldsOf", () => {
	it("maps TV's schema: scalars to typed controls, collections to json", () => {
		const fields = settingsFieldsOf("TV.app");
		const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));

		expect(byKey.captionsOn).toMatchObject({ control: "boolean" });
		expect(byKey.captionsOn.description).toMatch(/captions/i);
		expect(byKey.volumeLimit).toMatchObject({ control: "number" });
		expect(byKey.currentChannel).toMatchObject({ control: "string" });
		expect(byKey.channelVolumes).toMatchObject({ control: "json" });
		expect(byKey.selectedChannels).toMatchObject({ control: "json" });
	});

	it("treats a nested settings object as one json field (TimeMachine)", () => {
		const fields = settingsFieldsOf("TimeMachine.app");
		expect(fields.find((f) => f.key === "settings")).toMatchObject({ control: "json" });
	});

	it("unwraps optional/default and surfaces enum options", () => {
		const fields = settingsFieldsOf("FakeEnum.app");
		const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));

		expect(byKey.palette).toMatchObject({ control: "enum", options: ["warm", "cool"] });
		expect(byKey.palette.description).toBe("Color palette.");
		expect(byKey.retries).toMatchObject({ control: "number" });
	});

	it("returns no fields for an unregistered app", () => {
		expect(settingsFieldsOf("Nope.app")).toEqual([]);
	});
});

describe("defaultValueFor", () => {
	it("seeds each control kind with an editable placeholder", () => {
		expect(defaultValueFor({ key: "k", control: "boolean" })).toBe(false);
		expect(defaultValueFor({ key: "k", control: "number" })).toBe(0);
		expect(defaultValueFor({ key: "k", control: "string" })).toBe("");
		expect(defaultValueFor({ key: "k", control: "enum", options: ["a", "b"] })).toBe("a");
		expect(defaultValueFor({ key: "k", control: "json" })).toBe(null);
	});
});
