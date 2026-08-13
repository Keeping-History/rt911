import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RenameDialogForm } from "./RenameDialog";

afterEach(cleanup);

const field = () => screen.getByLabelText("Title");

describe("RenameDialogForm", () => {
	it("starts from the current title and renames to the edited value", () => {
		const onRename = vi.fn();
		render(<RenameDialogForm initialTitle="Lesson" onRename={onRename} onCancel={vi.fn()} />);

		expect(field()).toHaveValue("Lesson");
		fireEvent.change(field(), { target: { value: "Lesson Two" } });
		fireEvent.click(screen.getByRole("button", { name: "Rename" }));

		expect(onRename).toHaveBeenCalledWith("Lesson Two");
	});

	// A playlist with a blank title is unidentifiable in the list window.
	it("refuses an empty or whitespace-only title", () => {
		const onRename = vi.fn();
		render(<RenameDialogForm initialTitle="Lesson" onRename={onRename} onCancel={vi.fn()} />);

		fireEvent.change(field(), { target: { value: "   " } });

		expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Rename" }));
		expect(onRename).not.toHaveBeenCalled();
	});

	it("trims the saved title", () => {
		const onRename = vi.fn();
		render(<RenameDialogForm initialTitle="Lesson" onRename={onRename} onCancel={vi.fn()} />);

		fireEvent.change(field(), { target: { value: "  Padded  " } });
		fireEvent.click(screen.getByRole("button", { name: "Rename" }));

		expect(onRename).toHaveBeenCalledWith("Padded");
	});

	it("cancel reports nothing", () => {
		const onRename = vi.fn();
		const onCancel = vi.fn();
		render(<RenameDialogForm initialTitle="Lesson" onRename={onRename} onCancel={onCancel} />);

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(onCancel).toHaveBeenCalled();
		expect(onRename).not.toHaveBeenCalled();
	});
});
