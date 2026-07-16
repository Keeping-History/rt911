import type { ClassicyStore } from "classicy";
import { describe, expect, it } from "vitest";
import {
	classicyNewsEventHandler,
	newsFocusItem,
	newsSetOpenDocuments,
} from "./NewsContext";

function storeWithApp(data: Record<string, unknown> = {}): ClassicyStore {
	return {
		System: {
			Manager: {
				Applications: { apps: { "News.app": { data } } },
			},
		},
	} as unknown as ClassicyStore;
}

describe("classicyNewsEventHandler", () => {
	it("writes a seq-command carrying the docId", () => {
		const out = classicyNewsEventHandler(storeWithApp(), newsFocusItem(42));
		expect(out.System.Manager.Applications.apps["News.app"].data).toMatchObject({
			command: { seq: 1, kind: "focus", docId: 42 },
		});
	});

	it("increments seq monotonically across commands", () => {
		const ds = storeWithApp();
		classicyNewsEventHandler(ds, newsFocusItem(1));
		const out = classicyNewsEventHandler(ds, newsFocusItem(2));
		expect(out.System.Manager.Applications.apps["News.app"].data).toMatchObject({
			command: { seq: 2, kind: "focus", docId: 2 },
		});
	});

	it("publishes openDocuments, preserving unrelated fields", () => {
		const out = classicyNewsEventHandler(
			storeWithApp({ other: true }),
			newsSetOpenDocuments([7, 9]),
		);
		expect(out.System.Manager.Applications.apps["News.app"].data).toMatchObject({
			other: true,
			openDocuments: [7, 9],
		});
	});

	it("ignores unknown apps", () => {
		const ds = {
			System: { Manager: { Applications: { apps: {} } } },
		} as unknown as ClassicyStore;
		expect(() => classicyNewsEventHandler(ds, newsFocusItem(1))).not.toThrow();
	});
});
