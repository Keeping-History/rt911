import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthRequiredError } from "../../Providers/Auth/authApi";
import type { EditorState } from "./editorState";
import { useSavePlaylist } from "./useSavePlaylist";

const state = (over: Partial<EditorState> = {}): EditorState => ({
	playlistId: "p1",
	title: "Lesson",
	mode: "annotate",
	status: "draft",
	entries: [],
	selectedUid: null,
	dirty: true,
	nextUid: 1,
	...over,
});

const savedRecord = {
	id: "p1", title: "Lesson", status: "draft", date_updated: null, user_created: "u1",
	definition: { version: 1 as const, mode: "annotate" as const, entries: [] },
};

describe("useSavePlaylist", () => {
	it("writes and reports the saved record when the definition is clean", async () => {
		const update = vi.fn().mockResolvedValue(savedRecord);
		const onSaved = vi.fn();
		const { result } = renderHook(() => useSavePlaylist(state(), onSaved, update));

		act(() => result.current.save());

		await waitFor(() => expect(onSaved).toHaveBeenCalledWith(savedRecord));
		expect(update).toHaveBeenCalledWith("p1", {
			title: "Lesson",
			definition: { version: 1, mode: "annotate", entries: [] },
			status: "draft",
		});
		expect(result.current.prompt).toEqual({ kind: "none" });
	});

	// An entry that validation DROPS would vanish on next open, so saving is
	// blocked outright rather than offered as "save anyway".
	it("blocks the save when validation would drop entries", async () => {
		const update = vi.fn();
		const dirty = state({
			entries: [{ uid: "e1", entry: { kind: "jump", at: "", to: "" } }],
		});
		const { result } = renderHook(() => useSavePlaylist(dirty, vi.fn(), update));

		act(() => result.current.save());

		await waitFor(() => expect(result.current.prompt.kind).toBe("dropped"));
		expect(update).not.toHaveBeenCalled();
	});

	it("surfaces a sign-out as an actionable message instead of a generic failure", async () => {
		const update = vi.fn().mockRejectedValue(new AuthRequiredError("nope"));
		const { result } = renderHook(() => useSavePlaylist(state(), vi.fn(), update));

		act(() => result.current.save());

		await waitFor(() =>
			expect(result.current.prompt).toEqual({
				kind: "message",
				message: "You've been signed out. Sign in via the Account app, then save again.",
			}),
		);
	});

	it("dismiss clears the prompt without writing", async () => {
		const update = vi.fn().mockRejectedValue(new Error("boom"));
		const { result } = renderHook(() => useSavePlaylist(state(), vi.fn(), update));

		act(() => result.current.save());
		await waitFor(() => expect(result.current.prompt.kind).toBe("message"));

		act(() => result.current.dismiss());

		expect(result.current.prompt).toEqual({ kind: "none" });
	});
});
