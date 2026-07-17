import {
	type HCCommandContext,
	registerHyperCardCommand,
	registerHyperCardPart,
	registerHyperCardStack,
} from "classicy";
import { DirectusAudioPart } from "./DirectusAudioPart";
import { DirectusMultiviewPart } from "./DirectusMultiviewPart";
import { DirectusNewsPart } from "./DirectusNewsPart";
import { DirectusPagerPart } from "./DirectusPagerPart";
import { DirectusVideoPart } from "./DirectusVideoPart";
import { MP3_AUDIO_STACK_ID, mp3AudioStack } from "./mp3AudioStack";
import { NEWS_PAGER_STACK_ID, newsPagerStack } from "./newsPagerStack";
import { TV_CHANNEL_STACK_ID, tvChannelStack } from "./tvChannelStack";

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
	registerHyperCardPart("directusVideo", DirectusVideoPart);
	registerHyperCardPart("directusMultiview", DirectusMultiviewPart);
	registerHyperCardPart("directusNews", DirectusNewsPart);
	registerHyperCardPart("directusPager", DirectusPagerPart);

	// Actions (stack commands). `setDateTime` seeks the desktop's virtual clock;
	// the pure reducer can't touch the clock, so it queues an effect that
	// HyperCardClockBridge (mounted in Desktop) applies through the sanctioned
	// setDateTimeFromUtc seam. `to` is a UTC datetime literal; `toVar` reads it
	// from a stack variable instead.
	registerHyperCardCommand("setDateTime", {
		run: (ctx: HCCommandContext, action) => {
			const to =
				typeof action.toVar === "string"
					? String(ctx.getVar(action.toVar) ?? "")
					: typeof action.to === "string"
						? action.to
						: "";
			if (to) ctx.queueEffect("setDateTime", { to });
		},
	});

	// Built-in stacks that demonstrate the parts (File → Open in HyperCard).
	registerHyperCardStack(MP3_AUDIO_STACK_ID, mp3AudioStack.name, mp3AudioStack);
	registerHyperCardStack(TV_CHANNEL_STACK_ID, tvChannelStack.name, tvChannelStack);
	registerHyperCardStack(NEWS_PAGER_STACK_ID, newsPagerStack.name, newsPagerStack);
}
