import { describe, expect, it } from "vitest";
import type { ActionMessage, ClassicyStore } from "classicy";
import { classicyPlaylistEventHandler, playlistMergeAppData } from "./playlistStoreActions";

const makeStore = (): ClassicyStore =>
	({
		System: {
			Manager: {
				Applications: {
					apps: { "TV.app": { data: { captionsOn: false, volumeLimit: 1 } } },
				},
			},
		},
	}) as unknown as ClassicyStore;

describe("classicyPlaylistEventHandler", () => {
	it("merges values into the target app data, preserving other keys", () => {
		const ds = makeStore();
		classicyPlaylistEventHandler(ds, playlistMergeAppData("TV.app", { captionsOn: true }));
		const data = ds.System.Manager.Applications.apps["TV.app"].data as Record<string, unknown>;
		expect(data.captionsOn).toBe(true);
		expect(data.volumeLimit).toBe(1);
	});
	it("ignores unknown apps and unrelated actions", () => {
		const ds = makeStore();
		classicyPlaylistEventHandler(ds, playlistMergeAppData("Nope.app", { x: 1 }));
		classicyPlaylistEventHandler(ds, { type: "ClassicyAppPlaylistSomethingElse" } as ActionMessage);
		const data = ds.System.Manager.Applications.apps["TV.app"].data as Record<string, unknown>;
		expect(data.captionsOn).toBe(false);
	});
});
