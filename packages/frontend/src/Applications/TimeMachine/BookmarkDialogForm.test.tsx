import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BookmarkDialogForm } from "./BookmarkDialogForm";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

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

describe("BookmarkDialogForm balloon help", () => {
	it("explains why Save is dimmed while the title is empty", () => {
		vi.useFakeTimers();
		render(
			<BookmarkDialogForm
				{...base}
				mode="create"
				initial={{ title: "", category: "General", startDateUtc: "2001-09-11T12:46:40" }}
				onSave={() => {}}
			/>,
		);

		// Save is disabled here, so the hover is heard by the wrapper anchor —
		// a hook bound to the button itself would never fire (React delivers
		// no mouse events to disabled buttons).
		const anchor = screen
			.getByRole("button", { name: "Save" })
			.closest(".classicyBalloonHelpAnchor") as HTMLElement;
		expect(anchor).not.toBeNull();
		fireEvent.mouseEnter(anchor);
		act(() => {
			vi.advanceTimersByTime(600);
		});
		expect(screen.getByRole("tooltip").textContent).toContain(
			"give the bookmark a title first",
		);
	});
});
