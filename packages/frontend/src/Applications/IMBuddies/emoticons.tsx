import type { ReactNode } from "react";
import styles from "./IMBuddies.module.scss";

/**
 * Text emoticons AIM rendered as faces. Longest-first so ":-)" wins over ":)".
 * The label is what a screen reader announces in place of the graphic.
 */
export const EMOTICONS: ReadonlyArray<[string, string]> = [
	[":-)", "smiling"], [":-(", "frowning"], [";-)", "winking"],
	[":-/", "unsure"], [":-O", "surprised"], ["<3", "heart"],
	[":)", "smiling"], [":(", "frowning"],
];

// Word-boundary-ish: an emoticon must not fire inside a token, so "8:30" stays
// a time. Preceded by start-or-space, followed by end-or-space.
const PATTERN = new RegExp(
	`(^|\\s)(${EMOTICONS.map(([t]) => t.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")).join("|")})(?=\\s|$)`,
	"g",
);

const LABELS = new Map(EMOTICONS);

export function renderEmoticons(text: string): ReactNode[] {
	const out: ReactNode[] = [];
	let last = 0;
	let key = 0;
	for (const m of text.matchAll(PATTERN)) {
		const at = (m.index ?? 0) + m[1].length;
		if (at > last) out.push(text.slice(last, at));
		const token = m[2];
		out.push(
			<span
				key={`e${key++}`}
				data-emoticon={token}
				className={styles.emoticon}
				role="img"
				aria-label={LABELS.get(token) ?? token}
			/>,
		);
		last = at + token.length;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}
