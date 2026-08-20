import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BookmarkDialogForm } from "./BookmarkDialogForm";

afterEach(cleanup);

const base = {
	tzOffset: -4,
	onCancel: () => {},
};

describe("BookmarkDialogForm", () => {
	it("prefills title/category and time from initial (edit mode)", () => {
		render(
			<BookmarkDialogForm
				{...base}
				mode="edit"
				initial={{ title: "My moment", category: "Attacks", startDateUtc: "2001-09-11T12:46:40" }}
				onSave={() => {}}
			/>,
		);
		expect((screen.getByLabelText(/Title/i) as HTMLInputElement).value).toBe("My moment");
		expect((screen.getByLabelText(/Category/i) as HTMLInputElement).value).toBe("Attacks");
	});

	it("disables Save when the title is empty", () => {
		render(
			<BookmarkDialogForm
				{...base}
				mode="create"
				initial={{ title: "", category: "General", startDateUtc: "2001-09-11T12:46:40" }}
				onSave={() => {}}
			/>,
		);
		expect((screen.getByRole("button", { name: /Save/i }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("emits a UTC start_date built from the form on Save", () => {
		const onSave = vi.fn();
		render(
			<BookmarkDialogForm
				{...base}
				mode="create"
				initial={{ title: "T", category: "General", startDateUtc: "2001-09-11T12:46:40" }}
				onSave={onSave}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /Save/i }));
		expect(onSave).toHaveBeenCalledWith({
			title: "T",
			category: "General",
			start_date: "2001-09-11T12:46:40", // unchanged time round-trips to same UTC
		});
	});

	it("defaults an empty category to General on Save", () => {
		const onSave = vi.fn();
		render(
			<BookmarkDialogForm
				{...base}
				mode="create"
				initial={{ title: "T", category: "", startDateUtc: "2001-09-11T12:46:40" }}
				onSave={onSave}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /Save/i }));
		expect(onSave.mock.calls[0][0].category).toBe("General");
	});
});
