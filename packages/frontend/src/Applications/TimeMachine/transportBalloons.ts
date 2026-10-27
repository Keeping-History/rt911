// packages/frontend/src/Applications/TimeMachine/transportBalloons.ts
//
// Balloon-help copy for the transport row. A pure function so the text can
// be unit-tested, and so TimeMachine.tsx's JSX stays a row of buttons rather
// than a wall of prose. The distances are quoted live from the saved Settings
// values: a balloon that says "30 seconds" while the button actually moves
// the clock 5 minutes is worse than no balloon at all.

export type TransportControl =
	| "skipBack"
	| "stepBack"
	| "scrubBack"
	| "play"
	| "pause"
	| "scrubForward"
	| "stepForward"
	| "skipForward";

export interface TransportBalloon {
	title: string;
	content: string;
}

export interface TransportBalloonInputs {
	skipMinutes: number;
	stepSeconds: number;
	scrubSeconds: number;
	paused: boolean;
}

/**
 * "45 seconds", "1 minute", "2 minutes 30 seconds" — prose for a balloon,
 * unlike the Settings sliders' abbreviated "2 min 30 sec" value labels.
 */
export function describeDuration(totalSeconds: number): string {
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	const parts: string[] = [];
	if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
	if (seconds > 0 || parts.length === 0) {
		parts.push(`${seconds} ${seconds === 1 ? "second" : "seconds"}`);
	}
	return parts.join(" ");
}

const SETTINGS_HINT = "Choose Settings… from the File menu to change this distance.";

/**
 * One balloon per transport button. Play and Pause are mutually disabled,
 * and a Mac OS 8 balloon says *why* a dimmed control is unavailable rather
 * than describing what it would do, so their copy depends on `paused`.
 */
export function transportBalloons(
	input: TransportBalloonInputs,
): Record<TransportControl, TransportBalloon> {
	const skip = describeDuration(input.skipMinutes * 60);
	const step = describeDuration(input.stepSeconds);
	const scrub = describeDuration(input.scrubSeconds);
	return {
		skipBack: {
			title: "Skip Back",
			content: `Move the clock back ${skip}. ${SETTINGS_HINT}`,
		},
		stepBack: {
			title: "Step Back",
			content: `Move the clock back ${step}. ${SETTINGS_HINT}`,
		},
		scrubBack: {
			title: "Scrub Back",
			content: `Nudge the clock back ${scrub}. ${SETTINGS_HINT}`,
		},
		play: {
			title: "Play",
			content: input.paused
				? "Start the clock running again from this moment. Every app on the desktop picks up from here."
				: "Not available: the clock is already running. Click Pause to stop it.",
		},
		pause: {
			title: "Pause",
			content: input.paused
				? "Not available: the clock is already paused. Click Play to start it again."
				: "Stop the clock at this moment. TV, radio, pagers and news all hold here until you click Play.",
		},
		scrubForward: {
			title: "Scrub Forward",
			content: `Nudge the clock forward ${scrub}. ${SETTINGS_HINT}`,
		},
		stepForward: {
			title: "Step Forward",
			content: `Move the clock forward ${step}. ${SETTINGS_HINT}`,
		},
		skipForward: {
			title: "Skip Forward",
			content: `Move the clock forward ${skip}. ${SETTINGS_HINT}`,
		},
	};
}
