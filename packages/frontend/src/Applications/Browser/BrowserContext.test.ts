import type { ClassicyStore } from "classicy";
import { describe, expect, it } from "vitest";
import { browserNavigate, classicyBrowserEventHandler } from "./BrowserContext";

function storeWithApp(data: Record<string, unknown> = {}): ClassicyStore {
	return {
		System: {
			Manager: {
				Applications: { apps: { "Browser.app": { data } } },
			},
		},
	} as unknown as ClassicyStore;
}

describe("classicyBrowserEventHandler — remote navigate command", () => {
	it("writes a seq-command carrying the url", () => {
		const out = classicyBrowserEventHandler(
			storeWithApp(),
			browserNavigate("https://www.cnn.com/"),
		);
		expect(out.System.Manager.Applications.apps["Browser.app"].data).toMatchObject({
			command: { seq: 1, kind: "navigate", url: "https://www.cnn.com/" },
		});
	});

	it("increments seq monotonically across commands", () => {
		let ds = storeWithApp();
		ds = classicyBrowserEventHandler(ds, browserNavigate("https://a.example/"));
		const out = classicyBrowserEventHandler(ds, browserNavigate("https://b.example/"));
		expect(out.System.Manager.Applications.apps["Browser.app"].data).toMatchObject({
			command: { seq: 2, kind: "navigate", url: "https://b.example/" },
		});
	});
});
