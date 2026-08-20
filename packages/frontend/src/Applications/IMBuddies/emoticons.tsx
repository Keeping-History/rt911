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
// a time. Preceded by start-or-space, followed by end-or-space or punctuation.
const PATTERN = new RegExp(
	`(^|\\s)(${EMOTICONS.map(([t]) => t.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")).join("|")})(?=[\\s.,!?"')\\]\\}]|$)`,
	"g",
);

const LABELS = new Map(EMOTICONS);

function EmoticonFace({ token }: { token: string }) {
	const getFaceContent = (): ReactNode => {
		switch (token) {
			case ":-)" :
			case ":)" :
				return (
					<svg viewBox="0 0 13 13" xmlns="http://www.w3.org/2000/svg">
						<circle cx="6.5" cy="6.5" r="5.5" fill="#ffcc33" stroke="#b8860b" strokeWidth="1"/>
						<circle cx="4" cy="5" r="0.8" fill="black"/>
						<circle cx="9" cy="5" r="0.8" fill="black"/>
						<path d="M 4 8 Q 6.5 9 9 8" stroke="black" strokeWidth="1" fill="none" strokeLinecap="round"/>
					</svg>
				);
			case ":-(":
			case ":(":
				return (
					<svg viewBox="0 0 13 13" xmlns="http://www.w3.org/2000/svg">
						<circle cx="6.5" cy="6.5" r="5.5" fill="#ffcc33" stroke="#b8860b" strokeWidth="1"/>
						<circle cx="4" cy="5" r="0.8" fill="black"/>
						<circle cx="9" cy="5" r="0.8" fill="black"/>
						<path d="M 4 9 Q 6.5 8 9 9" stroke="black" strokeWidth="1" fill="none" strokeLinecap="round"/>
					</svg>
				);
			case ";-)":
				return (
					<svg viewBox="0 0 13 13" xmlns="http://www.w3.org/2000/svg">
						<circle cx="6.5" cy="6.5" r="5.5" fill="#ffcc33" stroke="#b8860b" strokeWidth="1"/>
						<circle cx="4" cy="5" r="0.8" fill="black"/>
						<path d="M 9 4.5 L 9.5 5.5" stroke="black" strokeWidth="1" strokeLinecap="round"/>
						<path d="M 4 8 Q 6.5 9 9 8" stroke="black" strokeWidth="1" fill="none" strokeLinecap="round"/>
					</svg>
				);
			case ":-/":
				return (
					<svg viewBox="0 0 13 13" xmlns="http://www.w3.org/2000/svg">
						<circle cx="6.5" cy="6.5" r="5.5" fill="#ffcc33" stroke="#b8860b" strokeWidth="1"/>
						<circle cx="4" cy="5" r="0.8" fill="black"/>
						<circle cx="9" cy="5" r="0.8" fill="black"/>
						<path d="M 4 8.5 L 9 7.5" stroke="black" strokeWidth="1" strokeLinecap="round"/>
					</svg>
				);
			case ":-O":
				return (
					<svg viewBox="0 0 13 13" xmlns="http://www.w3.org/2000/svg">
						<circle cx="6.5" cy="6.5" r="5.5" fill="#ffcc33" stroke="#b8860b" strokeWidth="1"/>
						<circle cx="4" cy="5" r="0.8" fill="black"/>
						<circle cx="9" cy="5" r="0.8" fill="black"/>
						<circle cx="6.5" cy="8.5" r="1.2" fill="black"/>
					</svg>
				);
			case "<3":
				return (
					<svg viewBox="0 0 13 13" xmlns="http://www.w3.org/2000/svg">
						<path d="M 6.5 11 L 2 7 C 1 6 1 4 2 3 C 3 2 4.5 2 5.5 3 L 6.5 4 L 7.5 3 C 8.5 2 10 2 11 3 C 12 4 12 6 11 7 L 6.5 11 Z" fill="red" stroke="#b8860b" strokeWidth="0.5"/>
					</svg>
				);
			default:
				return (
					<svg viewBox="0 0 13 13" xmlns="http://www.w3.org/2000/svg">
						<circle cx="6.5" cy="6.5" r="5.5" fill="#ffcc33" stroke="#b8860b" strokeWidth="1"/>
						<circle cx="4" cy="5" r="0.8" fill="black"/>
						<circle cx="9" cy="5" r="0.8" fill="black"/>
						<path d="M 4 8 Q 6.5 9 9 8" stroke="black" strokeWidth="1" fill="none" strokeLinecap="round"/>
					</svg>
				);
		}
	};

	return (
		<span
			data-emoticon={token}
			className={styles.emoticon}
			role="img"
			aria-label={LABELS.get(token) ?? token}
		>
			{getFaceContent()}
		</span>
	);
}

export function renderEmoticons(text: string): ReactNode[] {
	const out: ReactNode[] = [];
	let last = 0;
	let key = 0;
	for (const m of text.matchAll(PATTERN)) {
		const at = (m.index ?? 0) + m[1].length;
		if (at > last) out.push(text.slice(last, at));
		const token = m[2];
		out.push(<EmoticonFace key={`e${key++}`} token={token} />);
		last = at + token.length;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}
