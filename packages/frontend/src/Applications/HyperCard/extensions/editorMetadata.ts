/**
 * Editor metadata for rt911's HyperCard extensions: how the stack editor's
 * palette, inspector, and script builder present the directus* plugin parts
 * and the setDateTime command. Keys mirror EXACTLY what each part component
 * reads from `options` — see the doc comment atop each Directus*Part.tsx.
 */
import {
	type HCOptionField,
	registerHyperCardCommandEditorMeta,
	registerHyperCardPartEditorMeta,
} from "classicy";

const text = (key: string, label: string): HCOptionField => ({ key, label, kind: "text" });
const num = (key: string, label: string): HCOptionField => ({ key, label, kind: "number" });
const check = (key: string, label: string, dflt?: boolean): HCOptionField => ({
	key,
	label,
	kind: "checkbox",
	...(dflt === undefined ? {} : { default: dflt }),
});

export function registerHyperCardEditorMetadata(): void {
	registerHyperCardPartEditorMeta("directusAudio", {
		label: "Audio Clip",
		defaultSize: [200, 96],
		optionsSchema: [
			text("itemId", "Clip id (or variable)"),
			text("url", "Direct audio URL"),
		],
	});
	registerHyperCardPartEditorMeta("directusVideo", {
		label: "TV Video",
		defaultSize: [320, 180],
		defaultOptions: { controls: true },
		optionsSchema: [
			num("channelId", "TV channel id"),
			text("url", "Direct HLS URL"),
			text("start", "Start (offset or wall clock)"),
			text("end", "End (offset or wall clock)"),
			check("autoPlay", "Auto-play"),
			check("controls", "Controls", true),
			check("loop", "Loop"),
			check("captions", "Captions"),
			check("overlay", "Channel overlay"),
		],
	});
	registerHyperCardPartEditorMeta("directusMultiview", {
		label: "TV Multiview",
		defaultSize: [404, 236],
		defaultOptions: { audio: "solo", videos: [] },
		optionsSchema: [
			text("audio", "Audio (solo | all | mute)"),
			num("columns", "Columns (blank = auto)"),
			{ key: "videos", label: "Videos", kind: "json" },
		],
	});
	registerHyperCardPartEditorMeta("directusNews", {
		label: "News Item",
		defaultSize: [280, 160],
		optionsSchema: [
			text("itemId", "News item id (or variable)"),
			check("showImage", "Show image", true),
			check("showDate", "Show date", true),
		],
	});
	registerHyperCardPartEditorMeta("directusPager", {
		label: "Pager Message",
		defaultSize: [280, 120],
		optionsSchema: [text("itemId", "Pager item id (or variable)")],
	});
	registerHyperCardPartEditorMeta("directusWeatherStation", {
		label: "Weather Station",
		defaultSize: [260, 300],
		optionsSchema: [text("station", "ICAO station id")],
	});
	registerHyperCardPartEditorMeta("directusFlightMap", {
		label: "Flight Map",
		defaultSize: [404, 300],
		optionsSchema: [
			text("flight", "Flight (or variable)"),
			check("notablesOnly", "Notable flights only"),
			check("darkMap", "Dark map"),
			text("mapStyle", "Map style"),
			text("pinColor", "Pin color"),
			text("notablePinColor", "Notable pin color"),
			text("observerPinColor", "Observer pin color"),
			check("radarSweep", "Radar sweep"),
			num("trailMultiplier", "Trail multiplier"),
		],
	});

	registerHyperCardCommandEditorMeta("setDateTime", {
		label: "Set Date/Time",
		fields: [
			text("to", "UTC datetime, e.g. 2001-09-11T12:46:00Z"),
			text("toVar", "…or read it from this stack variable"),
		],
	});
}
