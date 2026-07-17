// HyperCard app content for 911realtime. The HyperCard *app* itself ships with
// classicy and is auto-mounted by ClassicyDesktop — this repo, per the frontend
// CLAUDE.md, only supplies configuration and content. Here that content is a
// set of extension parts that embed items from Directus collections into
// stacks, plus the built-in stacks that use them.
//
// Importing this module for its side effect registers the extensions with
// classicy's HyperCard plugin registries. Do it once, above the desktop (see
// Desktop.tsx), so the parts exist before any stack is opened.
import { registerHyperCardExtensions } from "./extensions/registerHyperCardExtensions";

registerHyperCardExtensions();

export { registerHyperCardExtensions } from "./extensions/registerHyperCardExtensions";
export { mp3AudioStack, MP3_AUDIO_STACK_ID } from "./extensions/mp3AudioStack";
export { tvChannelStack, TV_CHANNEL_STACK_ID } from "./extensions/tvChannelStack";
export { DirectusAudioPart } from "./extensions/DirectusAudioPart";
export { DirectusVideo, DirectusVideoPart } from "./extensions/DirectusVideoPart";
export { DirectusMultiviewPart } from "./extensions/DirectusMultiviewPart";
export { DirectusNewsPart } from "./extensions/DirectusNewsPart";
export { DirectusPagerPart } from "./extensions/DirectusPagerPart";
export { DirectusWeatherPart } from "./extensions/DirectusWeatherPart";
export { DirectusFlightMapPart } from "./extensions/DirectusFlightMapPart";
export { HyperCardClockBridge } from "./extensions/HyperCardClockBridge";
export {
	CLOCK_RANGE_START_ISO,
	CLOCK_RANGE_END_ISO,
	clampClockIso,
} from "./extensions/dateRange";
export {
	DIRECTUS_COLLECTIONS,
	fetchDirectusAudioItem,
	fetchDirectusItem,
	fetchDirectusVideoItem,
	fetchDirectusNewsItem,
	fetchDirectusPagerItem,
	type DirectusAudioItem,
	type DirectusVideoItem,
	type DirectusNewsItem,
	type DirectusPagerItem,
} from "./extensions/directusCollections";
