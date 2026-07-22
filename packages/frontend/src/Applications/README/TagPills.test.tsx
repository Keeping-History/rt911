import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { parseHex, pillColors, TagPills } from "./TagPills";
import type { ReadmeTag } from "./useReadmeArticles";

afterEach(cleanup);

describe("parseHex", () => {
	it("parses #rrggbb and #rgb", () => {
		expect(parseHex("#ff0000")).toEqual([255, 0, 0]);
		expect(parseHex("#0f0")).toEqual([0, 255, 0]);
		expect(parseHex("  #00FF00 ")).toEqual([0, 255, 0]);
	});
	it("returns null for invalid input", () => {
		expect(parseHex(null)).toBeNull();
		expect(parseHex("red")).toBeNull();
		expect(parseHex("#12")).toBeNull();
	});
});

describe("pillColors", () => {
	it("uses black text on a light background", () => {
		expect(pillColors("#ffff00").text).toBe("#000000");
	});
	it("uses white text on a dark background", () => {
		expect(pillColors("#000080").text).toBe("#ffffff");
	});
	it("falls back to theme vars when there is no valid color", () => {
		expect(pillColors(null)).toEqual({
			background: "var(--color-theme-05)",
			text: "var(--color-theme-06)",
		});
	});
});

describe("TagPills", () => {
	const tags: ReadmeTag[] = [
		{ id: 1, name: "Announcement", color: "#cc3333" },
		{ id: 2, name: "Bugfix", color: null },
	];

	it("renders a pill per tag", () => {
		render(<TagPills tags={tags} />);
		expect(screen.getByText("Announcement")).toBeDefined();
		expect(screen.getByText("Bugfix")).toBeDefined();
	});

	it("renders nothing for an empty tag list", () => {
		const { container } = render(<TagPills tags={[]} />);
		expect(container.firstChild).toBeNull();
	});
});
