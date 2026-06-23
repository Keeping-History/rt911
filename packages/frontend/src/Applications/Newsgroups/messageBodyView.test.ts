import { describe, expect, it } from "vitest";
import { messageBodyView } from "./messageBodyView";

// The message window's body editor (ClassicyTextEditor) is uncontrolled — it reads
// prefillValue into a <textarea defaultValue> once at mount and ignores later prop
// changes. Bodies arrive asynchronously after the window opens, so the view must
// supply a `key` that CHANGES when the body arrives, forcing React to remount the
// editor so it re-reads the now-available text. These tests lock that in.
describe("messageBodyView", () => {
	it("reports the loading state when the body is absent", () => {
		const view = messageBodyView(7001, {}, {});
		expect(view.value).toBe("Loading message…");
		expect(view.key).toBe("loading");
	});

	it("reports the body once present, with a key distinct from loading", () => {
		const loading = messageBodyView(7001, {}, {});
		const loaded = messageBodyView(7001, { 7001: "Hello." }, {});
		expect(loaded.value).toBe("Hello.");
		// The key MUST differ from the loading key, or the uncontrolled editor never
		// remounts and the window stays stuck on "Loading…".
		expect(loaded.key).not.toBe(loading.key);
	});

	it("treats a present-but-empty body as loaded, not loading", () => {
		const view = messageBodyView(7001, { 7001: "" }, {});
		expect(view.value).toBe("");
		expect(view.key).toBe("body");
	});

	it("reports an error when one is present and the body is absent", () => {
		const view = messageBodyView(7002, {}, { 7002: "message unavailable" });
		expect(view.value).toBe("message unavailable");
		expect(view.key).toBe("error");
	});

	it("prefers a present body over an error for the same id", () => {
		const view = messageBodyView(7003, { 7003: "recovered" }, { 7003: "stale error" });
		expect(view.value).toBe("recovered");
		expect(view.key).toBe("body");
	});
});
