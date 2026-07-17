import { registerHyperCardPart, registerHyperCardStack } from "classicy";
import { DirectusAudioPart } from "./DirectusAudioPart";
import { MP3_AUDIO_STACK_ID, mp3AudioStack } from "./mp3AudioStack";

// Registration must run once, before the HyperCard app opens a stack that uses
// a Directus part. Classicy's registries are last-write-wins Maps, so repeat
// calls (StrictMode double-invoke, HMR) are harmless — this guard just skips
// the redundant work.
let registered = false;

/**
 * Install the Directus-collection HyperCard extensions: the display parts and
 * the built-in stacks that showcase them. Called for its side effect from the
 * app entry (see `../index.ts`).
 */
export function registerHyperCardExtensions(): void {
	if (registered) return;
	registered = true;

	// Display parts — one registered `type` per embeddable collection.
	registerHyperCardPart("directusAudio", DirectusAudioPart);

	// Built-in stacks that demonstrate the parts (File → Open in HyperCard).
	registerHyperCardStack(MP3_AUDIO_STACK_ID, mp3AudioStack.name, mp3AudioStack);
}
