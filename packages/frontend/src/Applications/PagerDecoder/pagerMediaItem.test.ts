import { describe, expect, it } from "vitest";
import { completedLineToPagerMediaItem } from "./pagerMediaItem";
import type { CompletedLine } from "./usePagerPlayback";

const baseLine: CompletedLine = {
	id: "03:00:00-1060278-1234567890",
	timeKey: "03:00:00",
	provider: "Metrocall",
	text: "Server is UP",
	record: {
		timestamp: "2001-09-11 03:00:00",
		provider: "Metrocall",
		recipient_id: "1060278",
		id_type: "capcode",
		channel: "B",
		mode: "ALPHA",
		message: "Server is UP",
	},
};

describe("completedLineToPagerMediaItem", () => {
	it("uses the passed-in id", () => {
		const item = completedLineToPagerMediaItem(baseLine, 42);
		expect(item.id).toBe(42);
	});

	it("sets format to pager", () => {
		const item = completedLineToPagerMediaItem(baseLine, 1);
		expect(item.format).toBe("pager");
	});

	it("maps message to full_title", () => {
		const item = completedLineToPagerMediaItem(baseLine, 1);
		expect(item.full_title).toBe("Server is UP");
	});

	it("maps short message to title unchanged", () => {
		const item = completedLineToPagerMediaItem(baseLine, 1);
		expect(item.title).toBe("Server is UP");
	});

	it("truncates title at 100 characters", () => {
		const long = "A".repeat(120);
		const line: CompletedLine = {
			...baseLine,
			record: { ...baseLine.record, message: long },
		};
		const item = completedLineToPagerMediaItem(line, 1);
		expect(item.title).toBe("A".repeat(100));
		expect(item.full_title).toBe(long);
	});

	it("maps provider to source", () => {
		const item = completedLineToPagerMediaItem(baseLine, 1);
		expect(item.source).toBe("Metrocall");
	});

	it("converts timestamp to ISO8601 for start_date", () => {
		const item = completedLineToPagerMediaItem(baseLine, 1);
		expect(item.start_date).toBe("2001-09-11T03:00:00");
	});

	it("sets end_date equal to start_date", () => {
		const item = completedLineToPagerMediaItem(baseLine, 1);
		expect(item.end_date).toBe(item.start_date);
	});

	it("sets url to empty string", () => {
		const item = completedLineToPagerMediaItem(baseLine, 1);
		expect(item.url).toBe("");
	});

	it("sets approved=1, mute=0, volume=1, jump=0, trim=0", () => {
		const item = completedLineToPagerMediaItem(baseLine, 1);
		expect(item.approved).toBe(1);
		expect(item.mute).toBe(0);
		expect(item.volume).toBe(1);
		expect(item.jump).toBe(0);
		expect(item.trim).toBe(0);
	});

	it("stores structured fields as JSON in content", () => {
		const item = completedLineToPagerMediaItem(baseLine, 1);
		expect(item.content).toBeDefined();
		const parsed = JSON.parse(item.content!);
		expect(parsed.provider).toBe("Metrocall");
		expect(parsed.recipient_id).toBe("1060278");
		expect(parsed.id_type).toBe("capcode");
		expect(parsed.channel).toBe("B");
		expect(parsed.mode).toBe("ALPHA");
		expect(parsed.timestamp).toBe("2001-09-11 03:00:00");
	});

	it("preserves original timestamp string in content (not converted)", () => {
		const item = completedLineToPagerMediaItem(baseLine, 1);
		const parsed = JSON.parse(item.content!);
		expect(parsed.timestamp).toBe("2001-09-11 03:00:00");
	});
});
