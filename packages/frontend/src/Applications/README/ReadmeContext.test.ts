import type { ActionMessage, ClassicyStore } from "classicy";
import { describe, expect, it } from "vitest";
import { classicyReadmeEventHandler } from "./ReadmeContext";

// A minimal store shaped like the slice the handler touches.
function storeWith(data: Record<string, unknown> | undefined): ClassicyStore {
	return {
		System: {
			Manager: { Applications: { apps: { "Readme.app": { data } } } },
		},
	} as unknown as ClassicyStore;
}

describe("classicyReadmeEventHandler", () => {
	it("writes settings into the Readme.app data slice", () => {
		const ds = storeWith({ existing: true });
		const action = {
			type: "ClassicyAppReadmeSetSettings",
			settings: { hiddenTagIds: [5] },
		} as unknown as ActionMessage;
		const out = classicyReadmeEventHandler(ds, action);
		const data = out.System.Manager.Applications.apps["Readme.app"].data;
		expect(data).toEqual({ existing: true, settings: { hiddenTagIds: [5] } });
	});

	it("ignores actions it does not own", () => {
		const ds = storeWith({ settings: { hiddenTagIds: [] } });
		const out = classicyReadmeEventHandler(ds, { type: "SomethingElse" } as ActionMessage);
		expect(out.System.Manager.Applications.apps["Readme.app"].data).toEqual({
			settings: { hiddenTagIds: [] },
		});
	});

	it("no-ops when the app is not mounted", () => {
		const ds = { System: { Manager: { Applications: { apps: {} } } } } as unknown as ClassicyStore;
		expect(() =>
			classicyReadmeEventHandler(ds, {
				type: "ClassicyAppReadmeSetSettings",
				settings: { hiddenTagIds: [1] },
			} as unknown as ActionMessage),
		).not.toThrow();
	});
});
