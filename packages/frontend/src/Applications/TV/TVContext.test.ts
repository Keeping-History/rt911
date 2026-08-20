import type { ClassicyStore } from "classicy";
import { describe, expect, it } from "vitest";
import {
	type CaptionStyle,
	DEFAULT_CAPTION_STYLE,
	classicyTVEventHandler,
	tvSetChannelOrder,
} from "./TVContext";

function storeWithApp(data: Record<string, unknown> = {}): ClassicyStore {
	return {
		System: {
			Manager: {
				Applications: { apps: { "TV.app": { data } } },
			},
		},
	} as unknown as ClassicyStore;
}

describe("classicyTVEventHandler — caption state", () => {
	it("persists captionsOn and captionStyle", () => {
		const style: CaptionStyle = { ...DEFAULT_CAPTION_STYLE, font: "--body-font" };
		const out = classicyTVEventHandler(storeWithApp(), {
			type: "ClassicyAppTVSetCaptionState",
			captionsOn: true,
			captionStyle: style,
		});
		expect(
			out.System.Manager.Applications.apps["TV.app"].data,
		).toMatchObject({ captionsOn: true, captionStyle: style });
	});

	it("preserves unrelated fields when writing caption state", () => {
		const out = classicyTVEventHandler(storeWithApp({ overallMuted: true }), {
			type: "ClassicyAppTVSetCaptionState",
			captionsOn: false,
			captionStyle: DEFAULT_CAPTION_STYLE,
		});
		expect(
			out.System.Manager.Applications.apps["TV.app"].data,
		).toMatchObject({ overallMuted: true, captionsOn: false });
	});
});

describe("classicyTVEventHandler — active player", () => {
	it("persists activePlayer", () => {
		const out = classicyTVEventHandler(storeWithApp(), {
			type: "ClassicyAppTVSetActivePlayer",
			activePlayer: 42,
		});
		expect(
			out.System.Manager.Applications.apps["TV.app"].data,
		).toMatchObject({ activePlayer: 42 });
	});

	it("preserves unrelated fields when writing active player", () => {
		const out = classicyTVEventHandler(storeWithApp({ overallMuted: true }), {
			type: "ClassicyAppTVSetActivePlayer",
			activePlayer: 7,
		});
		expect(
			out.System.Manager.Applications.apps["TV.app"].data,
		).toMatchObject({ overallMuted: true, activePlayer: 7 });
	});
});

describe("classicyTVEventHandler — guard cases", () => {
	it("ignores unrelated action types", () => {
		const ds = storeWithApp({ captionsOn: true });
		expect(classicyTVEventHandler(ds, { type: "SomethingElse" })).toBe(ds);
	});

	it("returns store unchanged when TV.app is not registered — caption state", () => {
		const empty = {
			System: { Manager: { Applications: { apps: {} } } },
		} as unknown as ClassicyStore;
		expect(
			classicyTVEventHandler(empty, { type: "ClassicyAppTVSetCaptionState" }),
		).toBe(empty);
	});

	it("returns store unchanged when TV.app is not registered — active player", () => {
		const empty = {
			System: { Manager: { Applications: { apps: {} } } },
		} as unknown as ClassicyStore;
		expect(
			classicyTVEventHandler(empty, { type: "ClassicyAppTVSetActivePlayer" }),
		).toBe(empty);
	});
});

describe("classicyTVEventHandler — current channel", () => {
	it("persists the active channel's source slug", () => {
		const out = classicyTVEventHandler(storeWithApp(), {
			type: "ClassicyAppTVSetCurrentChannel",
			source: "CNN",
		});
		expect(
			out.System.Manager.Applications.apps["TV.app"].data,
		).toMatchObject({ currentChannel: "CNN" });
	});

	it("preserves unrelated fields when writing current channel", () => {
		const out = classicyTVEventHandler(storeWithApp({ overallMuted: true }), {
			type: "ClassicyAppTVSetCurrentChannel",
			source: "ABC",
		});
		expect(
			out.System.Manager.Applications.apps["TV.app"].data,
		).toMatchObject({ overallMuted: true, currentChannel: "ABC" });
	});
});

describe("classicyTVEventHandler — channel order", () => {
	it("persists the channel order", () => {
		const out = classicyTVEventHandler(
			storeWithApp({ volumeLimit: 0.5 }),
			tvSetChannelOrder(["WCBS", "WABC"]),
		);
		expect(
			out.System.Manager.Applications.apps["TV.app"].data,
		).toMatchObject({ channelOrder: ["WCBS", "WABC"] });
	});

	it("preserves unrelated fields when writing channel order", () => {
		const out = classicyTVEventHandler(
			storeWithApp({ volumeLimit: 0.5, captionsOn: true }),
			tvSetChannelOrder(["WABC"]),
		);
		expect(
			out.System.Manager.Applications.apps["TV.app"].data,
		).toMatchObject({ volumeLimit: 0.5, captionsOn: true, channelOrder: ["WABC"] });
	});

	it("accepts an empty order (reset to default ordering)", () => {
		const out = classicyTVEventHandler(
			storeWithApp({ channelOrder: ["WABC"] }),
			tvSetChannelOrder([]),
		);
		expect(
			out.System.Manager.Applications.apps["TV.app"].data,
		).toMatchObject({ channelOrder: [] });
	});
});

describe("classicyTVEventHandler — grid selection (slug-based)", () => {
	it("persists selectedChannels, mutedChannels and channelVolumes", () => {
		const out = classicyTVEventHandler(storeWithApp(), {
			type: "ClassicyAppTVSetGridState",
			multiSelectMode: true,
			selectedChannels: ["WABC", "WNBC"],
			mutedChannels: ["WNBC"],
			channelVolumes: { WABC: 0.5 },
		});
		expect(
			out.System.Manager.Applications.apps["TV.app"].data,
		).toMatchObject({
			multiSelectMode: true,
			selectedChannels: ["WABC", "WNBC"],
			mutedChannels: ["WNBC"],
			channelVolumes: { WABC: 0.5 },
		});
	});

	it("preserves unrelated fields when writing grid state", () => {
		const out = classicyTVEventHandler(storeWithApp({ currentChannel: "CNN" }), {
			type: "ClassicyAppTVSetGridState",
			multiSelectMode: false,
			selectedChannels: [],
			mutedChannels: [],
			channelVolumes: {},
		});
		expect(
			out.System.Manager.Applications.apps["TV.app"].data,
		).toMatchObject({ currentChannel: "CNN", multiSelectMode: false, selectedChannels: [] });
	});
});
