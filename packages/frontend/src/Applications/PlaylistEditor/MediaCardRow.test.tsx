import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaCardRow, type MediaCardEntry } from "./MediaCardRow";

afterEach(cleanup);

const entry = (uid: string, itemId: string): MediaCardEntry => ({
	uid,
	entry: { kind: "media", app: "tv", itemId },
});

const cardRow = (entries: MediaCardEntry[], props: Partial<{
	selectedUid: string | null;
	onSelect: (uid: string) => void;
	onEdit: (uid: string) => void;
	onRemove: (uid: string) => void;
}> = {}) =>
	render(
		<MediaCardRow
			entries={entries}
			selectedUid={props.selectedUid ?? null}
			onSelect={props.onSelect ?? vi.fn()}
			onEdit={props.onEdit ?? vi.fn()}
			onRemove={props.onRemove ?? vi.fn()}
			logoFor={() => undefined}
			listLabel="Test cards"
		/>,
	);

describe("MediaCardRow", () => {
	it("clicking a card calls onSelect with its uid", () => {
		const onSelect = vi.fn();
		cardRow([entry("e1", "cnn")], { onSelect });
		screen.getByRole("listitem").click();
		expect(onSelect).toHaveBeenCalledWith("e1");
	});

	it("clicking Edit or Remove does not also call onSelect", () => {
		const onSelect = vi.fn();
		const onEdit = vi.fn();
		const onRemove = vi.fn();
		cardRow([entry("e1", "cnn")], { onSelect, onEdit, onRemove });

		screen.getByRole("button", { name: "Edit CNN" }).click();
		expect(onEdit).toHaveBeenCalledWith("e1");
		expect(onSelect).not.toHaveBeenCalled();

		screen.getByRole("button", { name: "Remove CNN" }).click();
		expect(onRemove).toHaveBeenCalledWith("e1");
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("Enter or Space on a focused card calls onSelect", () => {
		const onSelect = vi.fn();
		cardRow([entry("e1", "cnn")], { onSelect });
		const card = screen.getByRole("listitem");

		fireEvent.keyDown(card, { key: "Enter" });
		expect(onSelect).toHaveBeenCalledWith("e1");

		onSelect.mockClear();
		fireEvent.keyDown(card, { key: " " });
		expect(onSelect).toHaveBeenCalledWith("e1");
	});

	it("ignores other keys on a focused card", () => {
		const onSelect = vi.fn();
		cardRow([entry("e1", "cnn")], { onSelect });
		fireEvent.keyDown(screen.getByRole("listitem"), { key: "Tab" });
		expect(onSelect).not.toHaveBeenCalled();
	});
});

describe("MediaCardRow › window summary", () => {
	it("labels each card with its own window, so two windows of one station read apart", () => {
		cardRow([
			{ uid: "a", entry: { kind: "media", app: "tv", itemId: "weta", start: "2001-09-11T12:40:00Z", end: "2001-09-11T13:30:00Z" } },
			{ uid: "b", entry: { kind: "media", app: "tv", itemId: "weta", start: "2001-09-11T13:55:00Z", end: "2001-09-11T14:30:00Z" } },
			{ uid: "c", entry: { kind: "media", app: "tv", itemId: "cnn" } },
		]);
		const summaries = [...document.querySelectorAll(".playlistMediaCardWindow")].map((el) => el.textContent);
		expect(summaries).toEqual(["9/11 08:40–09:30", "9/11 09:55–10:30", "always"]);
	});
});
