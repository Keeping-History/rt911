import { describe, expect, it } from "vitest";
import { provenanceRows } from "./provenance";

describe("provenanceRows", () => {
	it("reads the commission, the per-path sources and the generation stamp", () => {
		const rows = provenanceRows({
			generated_at: "2026-08-14T09:12:00Z",
			sources: { subject: "transcript", participants: "callsign roster" },
			commission: {
				title: "9/11 Commission Report",
				source: "NARA",
				stamp: "Chapter 1, note 44",
			},
		});
		expect(rows.map((r) => r.value)).toEqual([
			"9/11 Commission Report",
			"NARA",
			"Chapter 1, note 44",
			"transcript",
			"callsign roster",
			"2026-08-14T09:12:00Z",
		]);
	});

	it("labels each source by the field it accounts for", () => {
		const rows = provenanceRows({ sources: { start_date: "Directus" } });
		expect(rows).toEqual([{ label: "Start date", value: "Directus" }]);
	});

	it("drops the entries a derivation left null rather than printing blanks", () => {
		const rows = provenanceRows({
			generated_at: null,
			sources: { subject: null, participants: "" },
			commission: { title: "Report", source: null, stamp: undefined },
		});
		expect(rows).toEqual([{ label: "Title", value: "Report" }]);
	});

	it("is empty for an item whose derivation never ran", () => {
		// 59 of 814 rows have no `parties`, so `provenance` is simply absent.
		expect(provenanceRows(undefined)).toEqual([]);
		expect(provenanceRows(null)).toEqual([]);
	});

	it("is empty rather than throwing when provenance is not the shape we expect", () => {
		// ItemMeta types provenance as `unknown` on purpose — the wire is the
		// only thing that decides its shape, and a producer change must degrade
		// to an empty panel, never a thrown render.
		expect(provenanceRows("a string")).toEqual([]);
		expect(provenanceRows(42)).toEqual([]);
		expect(provenanceRows(["a", "list"])).toEqual([]);
		expect(provenanceRows({ sources: "not an object", commission: 7 })).toEqual([]);
	});

	it("renders a structured source value instead of [object Object]", () => {
		const rows = provenanceRows({ sources: { subject: { from: "transcript" } } });
		expect(rows).toEqual([{ label: "Subject", value: '{"from":"transcript"}' }]);
	});
});
