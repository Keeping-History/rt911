import { describe, expect, it } from "vitest";
import type { UsenetItem } from "../../Providers/MediaStream/MediaStreamContext";
import { buildThreadTree, messageLabel } from "./newsgroupUtils";

function msg(
	id: number,
	message_id: string,
	parent_id: string | undefined,
	start_date: string,
	extra: Partial<UsenetItem> = {},
): UsenetItem {
	return { id, message_id, parent_id, start_date, ...extra };
}

describe("buildThreadTree", () => {
	it("indents a reply chain by depth", () => {
		const tree = buildThreadTree([
			msg(3, "<c>", "<b>", "2001-01-01T03:00:00Z"),
			msg(1, "<a>", undefined, "2001-01-01T01:00:00Z"),
			msg(2, "<b>", "<a>", "2001-01-01T02:00:00Z"),
		]);
		expect(tree.map((n) => [n.item.message_id, n.depth])).toEqual([
			["<a>", 0],
			["<b>", 1],
			["<c>", 2],
		]);
	});

	it("orders roots chronologically and nests each thread's replies", () => {
		const tree = buildThreadTree([
			msg(10, "<t2>", undefined, "2001-01-02T00:00:00Z"),
			msg(11, "<t2r>", "<t2>", "2001-01-02T01:00:00Z"),
			msg(20, "<t1>", undefined, "2001-01-01T00:00:00Z"),
		]);
		expect(tree.map((n) => n.item.message_id)).toEqual(["<t1>", "<t2>", "<t2r>"]);
	});

	it("treats a message whose parent is absent as a root", () => {
		const tree = buildThreadTree([msg(1, "<x>", "<missing>", "2001-01-01T00:00:00Z")]);
		expect(tree).toEqual([{ item: expect.objectContaining({ message_id: "<x>" }), depth: 0 }]);
	});

	it("terminates and keeps every message when a cycle exists", () => {
		const tree = buildThreadTree([
			msg(1, "<a>", "<b>", "2001-01-01T00:00:00Z"),
			msg(2, "<b>", "<a>", "2001-01-01T00:01:00Z"),
		]);
		expect(tree).toHaveLength(2);
		expect(new Set(tree.map((n) => n.item.id))).toEqual(new Set([1, 2]));
	});
});

describe("messageLabel", () => {
	it("falls back when subject/author are missing", () => {
		expect(messageLabel({ id: 1, start_date: "x" })).toBe("(no subject)");
		expect(messageLabel({ id: 1, start_date: "x", subject: "Hi", author: "A <a@x>" })).toBe(
			"Hi — A <a@x>",
		);
	});
});
