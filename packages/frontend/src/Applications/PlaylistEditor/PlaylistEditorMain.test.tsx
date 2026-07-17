import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const dialogProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyFileOpenDialog: (props: Record<string, unknown>) => {
		dialogProps.current = props;
		return props.open ? <div data-testid="file-open-dialog" /> : null;
	},
	useClassicyFileSystem: () => ({ fs: {}, separator: ":", resolve: () => undefined }),
}));
vi.mock("../../Providers/MediaStream/useMediaStream", () => ({
	useMediaStream: () => ({ sources: { video: ["ABC"], audio: ["KCBS"], pager: [], usenet: [] } }),
}));

import { PlaylistEditorMain } from "./PlaylistEditorMain";

const record = {
	id: "p1", title: "Lesson", status: "draft" as const, date_updated: null, user_created: "u1",
	definition: { version: 1, mode: "restrict", entries: [{ kind: "media", app: "tv", itemId: "ABC" }] },
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	dialogProps.current = null;
});

describe("PlaylistEditorMain", () => {
	it("renders entry-kind branches and the loaded entry", () => {
		render(<PlaylistEditorMain record={record} onBack={() => {}} />);
		expect(screen.getByText("Media")).not.toBeNull();
		expect(screen.getByText("TV · ABC")).not.toBeNull();
	});

	it("opens the file dialog in multi mode for Add Media…", () => {
		render(<PlaylistEditorMain record={record} onBack={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Add Media…" }));
		expect(screen.getByTestId("file-open-dialog")).not.toBeNull();
		expect(dialogProps.current?.selectionMode).toBe("multi");
		expect((dialogProps.current?.volumes as { id: string }[]).map((v) => v.id))
			.toEqual(["desktop", "fs-Macintosh HD", "rt911-archive"]);
	});

	it("adds entries from a dialog selection", () => {
		render(<PlaylistEditorMain record={record} onBack={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Add Media…" }));
		act(() => {
			(dialogProps.current?.onOpenFunc as (s: unknown[]) => void)([
				{ volumeId: "rt911-archive", path: ["Radio Stations"],
					entry: { id: "radio-KCBS", name: "KCBS", kind: "file", fileType: "radio-station",
						meta: { app: "radio", itemId: "KCBS" } } },
			]);
		});
		expect(screen.getByText("RADIO · KCBS")).not.toBeNull();
	});

	it("selects an entry for editing via its Edit button and removes via Remove", () => {
		render(<PlaylistEditorMain record={record} onBack={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		expect(screen.getByRole("combobox", { name: /focus/i })).not.toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		expect(screen.queryByText("TV · ABC")).toBeNull();
	});
});
