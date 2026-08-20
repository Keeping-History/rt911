import { describe, expect, it } from "vitest";
import { visibleEpgChannels } from "./epgVisibility";

const ch = (name: string) => ({ name });
const GUIDE = [ch("CNN"), ch("BBC"), ch("CCTV4"), ch("WNYW")];

describe("visibleEpgChannels", () => {
	it("drops the channels the user switched off", () => {
		expect(visibleEpgChannels(GUIDE, ["BBC"]).map((c) => c.name))
			.toEqual(["CNN", "CCTV4", "WNYW"]);
	});

	it("shows everything when nothing is disabled", () => {
		expect(visibleEpgChannels(GUIDE, []).map((c) => c.name))
			.toEqual(["CNN", "BBC", "CCTV4", "WNYW"]);
		expect(visibleEpgChannels(GUIDE, undefined).map((c) => c.name))
			.toEqual(["CNN", "BBC", "CCTV4", "WNYW"]);
	});

	it("matches regardless of case, as resolveChannelId does", () => {
		// guide.json spells channels "CNN" while the slug list is free to differ;
		// the two agree on case today only by coincidence.
		expect(visibleEpgChannels(GUIDE, ["cnn", "cctv4"]).map((c) => c.name))
			.toEqual(["BBC", "WNYW"]);
		expect(visibleEpgChannels([ch("cnn")], ["CNN"])).toEqual([]);
	});

	it("keeps a channel that has no source rather than hiding it", () => {
		// WNYW is in the guide but no source provides it, so it never appears in
		// Settings. Hiding it would take away a channel the user has no control
		// to restore — the list is a blacklist, not a whitelist.
		expect(visibleEpgChannels(GUIDE, ["CNN", "BBC", "CCTV4"]).map((c) => c.name))
			.toEqual(["WNYW"]);
	});

	it("does not mutate or alias the input", () => {
		const input = [ch("CNN"), ch("BBC")];
		const out = visibleEpgChannels(input, []);
		out.push(ch("EXTRA"));
		expect(input).toHaveLength(2);
	});

	it("leaves order untouched", () => {
		expect(visibleEpgChannels(GUIDE, ["BBC"]).map((c) => c.name))
			.toEqual(["CNN", "CCTV4", "WNYW"]);
	});
});
