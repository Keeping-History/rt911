import { describe, expect, it } from "vitest";
import type { AlertItem } from "./MediaStreamContext";
import { partitionByDue } from "./revealBuffer";

describe("alert reveal gating", () => {
	it("buffers a future alert and surfaces a due one", () => {
		const now = Date.parse("2001-09-11T12:40:00Z");
		const alerts: AlertItem[] = [
			{
				id: 1,
				title: "Now",
				start_date: "2001-09-11T12:40:00Z",
				url: "",
				format: "",
				approved: 1,
				mute: 0,
				volume: 1,
				jump: 0,
				trim: 0,
				full_title: "",
			},
			{
				id: 2,
				title: "Later",
				start_date: "2001-09-11T12:45:00Z",
				url: "",
				format: "",
				approved: 1,
				mute: 0,
				volume: 1,
				jump: 0,
				trim: 0,
				full_title: "",
			},
		];
		const { due, future } = partitionByDue(alerts, now);
		expect(due.map((a) => a.id)).toEqual([1]);
		expect(future.map((a) => a.id)).toEqual([2]);
	});
});
