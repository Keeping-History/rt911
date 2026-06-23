/**
 * Decide what the message window's body area should show for one message, and a
 * `key` that identifies the current state. The body editor is uncontrolled (it
 * snapshots its initial text at mount), so the consumer uses this `key` on the
 * editor: when a body arrives the key flips from "loading" to "body", forcing a
 * remount that re-reads the now-available text. Precedence: a present (even empty)
 * body wins, then an error, otherwise the loading placeholder.
 */
export interface MessageBodyView {
	/** Identifies the state; used as the editor's React key to force a remount on change. */
	key: "body" | "error" | "loading";
	/** The text to display in the body area. */
	value: string;
}

export function messageBodyView(
	id: number,
	bodies: Record<number, string>,
	errors: Record<number, string>,
): MessageBodyView {
	if (id in bodies) return { key: "body", value: bodies[id] };
	if (id in errors) return { key: "error", value: errors[id] };
	return { key: "loading", value: "Loading message…" };
}
