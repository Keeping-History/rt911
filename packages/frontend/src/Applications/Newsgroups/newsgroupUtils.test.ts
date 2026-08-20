import { describe, expect, it } from "vitest";
import type { UsenetItem } from "../../Providers/MediaStream/MediaStreamContext";
import { buildThreads, flattenThreads, sortThreads } from "./newsgroupUtils";

const epoch = (s: string) => new Date(s).getTime();

function msg(
	id: number,
	message_id: string,
	parent_id: string | undefined,
	start_date: string,
	extra: Partial<UsenetItem> = {},
): UsenetItem {
	return { id, message_id, parent_id, start_date, ...extra };
}

describe("buildThreads", () => {
	it("groups a root and its replies into one thread with a full count", () => {
		const threads = buildThreads([
			msg(1, "<a>", undefined, "2001-01-01T01:00:00Z"),
			msg(2, "<b>", "<a>", "2001-01-01T02:00:00Z"),
			msg(3, "<c>", "<b>", "2001-01-01T03:00:00Z"),
		]);
		expect(threads).toHaveLength(1);
		expect(threads[0].root.message_id).toBe("<a>");
		expect(threads[0].count).toBe(3);
		expect(threads[0].nodes.map((n) => [n.item.message_id, n.depth])).toEqual([
			["<a>", 0],
			["<b>", 1],
			["<c>", 2],
		]);
	});

	it("sets latestDate to the newest message anywhere in the thread", () => {
		const threads = buildThreads([
			msg(1, "<a>", undefined, "2001-01-01T01:00:00Z"),
			msg(2, "<b>", "<a>", "2001-09-13T15:01:00Z"),
		]);
		expect(threads[0].latestDate).toBe(epoch("2001-09-13T15:01:00Z"));
		expect(threads[0].rootDate).toBe(epoch("2001-01-01T01:00:00Z"));
	});

	it("keys a thread on the root message_id, falling back to id when absent", () => {
		const [withId] = buildThreads([msg(1, "<a>", undefined, "2001-01-01T00:00:00Z")]);
		expect(withId.key).toBe("<a>");
		const noId: UsenetItem = { id: 7, start_date: "2001-01-01T00:00:00Z" };
		const [withoutId] = buildThreads([noId]);
		expect(withoutId.key).toBe("id:7");
	});

	it("produces one thread per independent root", () => {
		const threads = buildThreads([
			msg(1, "<a>", undefined, "2001-01-01T00:00:00Z"),
			msg(2, "<b>", undefined, "2001-01-02T00:00:00Z"),
		]);
		expect(threads).toHaveLength(2);
	});

	it("treats a message whose parent is absent as its own thread root", () => {
		const threads = buildThreads([msg(1, "<x>", "<missing>", "2001-01-01T00:00:00Z")]);
		expect(threads).toHaveLength(1);
		expect(threads[0].root.message_id).toBe("<x>");
		expect(threads[0].count).toBe(1);
	});

	it("keeps every message when a reference cycle exists", () => {
		const threads = buildThreads([
			msg(1, "<a>", "<b>", "2001-01-01T00:00:00Z"),
			msg(2, "<b>", "<a>", "2001-01-01T00:01:00Z"),
		]);
		const ids = new Set(threads.flatMap((t) => t.nodes.map((n) => n.item.id)));
		expect(ids).toEqual(new Set([1, 2]));
	});
});

describe("sortThreads", () => {
	const threads = () =>
		buildThreads([
			// thread "apple": root old, reply newest
			msg(1, "<apple>", undefined, "2001-01-01T00:00:00Z", { subject: "Apple", author: "zoe" }),
			msg(2, "<apple-r>", "<apple>", "2001-09-20T00:00:00Z", { subject: "Re: Apple", author: "al" }),
			// thread "banana": root newer than apple root, no replies
			msg(3, "<banana>", undefined, "2001-05-01T00:00:00Z", { subject: "Banana", author: "amy" }),
		]);

	it("orders by latest activity descending (newest thread first)", () => {
		const out = sortThreads(threads(), { field: "date", dir: "desc" });
		expect(out.map((t) => t.root.message_id)).toEqual(["<apple>", "<banana>"]);
	});

	it("orders by latest activity ascending", () => {
		const out = sortThreads(threads(), { field: "date", dir: "asc" });
		expect(out.map((t) => t.root.message_id)).toEqual(["<banana>", "<apple>"]);
	});

	it("orders by root subject case-insensitively", () => {
		const out = sortThreads(threads(), { field: "subject", dir: "asc" });
		expect(out.map((t) => t.root.subject)).toEqual(["Apple", "Banana"]);
	});

	it("orders by root author and respects descending", () => {
		const out = sortThreads(threads(), { field: "author", dir: "desc" });
		expect(out.map((t) => t.root.author)).toEqual(["zoe", "amy"]);
	});

	it("never reorders replies within a thread", () => {
		const out = sortThreads(threads(), { field: "subject", dir: "desc" });
		const apple = out.find((t) => t.key === "<apple>")!;
		expect(apple.nodes.map((n) => n.item.message_id)).toEqual(["<apple>", "<apple-r>"]);
	});
});

describe("flattenThreads", () => {
	const built = () =>
		buildThreads([
			msg(1, "<a>", undefined, "2001-01-01T01:00:00Z"),
			msg(2, "<b>", "<a>", "2001-09-13T15:01:00Z"),
			msg(3, "<solo>", undefined, "2001-02-02T00:00:00Z"),
		]);

	it("shows only root rows when nothing is expanded, with thread count and latest date", () => {
		const rows = flattenThreads(built(), new Set());
		expect(rows.map((r) => r.item.message_id)).toEqual(["<a>", "<solo>"]);
		const a = rows.find((r) => r.threadKey === "<a>")!;
		expect(a.isRoot).toBe(true);
		expect(a.collapsed).toBe(true);
		expect(a.count).toBe(2);
		expect(a.hasChildren).toBe(true);
		expect(epoch(a.displayDate)).toBe(epoch("2001-09-13T15:01:00Z"));
	});

	it("marks a childless thread as having no children", () => {
		const rows = flattenThreads(built(), new Set());
		const solo = rows.find((r) => r.threadKey === "<solo>")!;
		expect(solo.hasChildren).toBe(false);
		expect(solo.count).toBe(1);
	});

	it("expands a thread into root + indented replies showing their own dates", () => {
		const rows = flattenThreads(built(), new Set(["<a>"]));
		expect(rows.map((r) => [r.item.message_id, r.depth])).toEqual([
			["<a>", 0],
			["<b>", 1],
			["<solo>", 0],
		]);
		const root = rows.find((r) => r.item.message_id === "<a>")!;
		expect(root.collapsed).toBe(false);
		expect(epoch(root.displayDate)).toBe(epoch("2001-01-01T01:00:00Z"));
		const reply = rows.find((r) => r.item.message_id === "<b>")!;
		expect(reply.isRoot).toBe(false);
		expect(epoch(reply.displayDate)).toBe(epoch("2001-09-13T15:01:00Z"));
	});
});
