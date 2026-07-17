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
export { DirectusAudioPart } from "./extensions/DirectusAudioPart";
export {
	DIRECTUS_COLLECTIONS,
	fetchDirectusAudioItem,
	fetchDirectusItem,
	type DirectusAudioItem,
} from "./extensions/directusCollections";
