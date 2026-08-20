import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaylistWindowDialogForm } from "./PlaylistWindowDialog";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const START = "2001-09-11T12:00:00.000Z";
const END = "2001-09-11T14:00:00.000Z";

describe("PlaylistWindowDialogForm", () => {
	it("starts unbounded on both ends and saves an empty window", () => {
		const onSave = vi.fn();
		render(
			<PlaylistWindowDialogForm
				initialStart={undefined} initialEnd={undefined}
				onSave={onSave} onCancel={vi.fn()}
			/>,
		);
		const unbounded = screen.getAllByLabelText("Not Time Bound") as HTMLInputElement[];
		expect(unbounded).toHaveLength(2);
		expect(unbounded.every((c) => c.checked)).toBe(true);

		fireEvent.click(screen.getByRole("button", { name: "OK" }));
		expect(onSave).toHaveBeenCalledWith({ start: undefined, end: undefined });
	});

	it("saves the existing bounds untouched", () => {
		const onSave = vi.fn();
		render(
			<PlaylistWindowDialogForm
				initialStart={START} initialEnd={END}
				onSave={onSave} onCancel={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "OK" }));
		expect(onSave).toHaveBeenCalledWith({ start: START, end: END });
	});

	it("unchecking Not Time Bound seeds a bound; re-checking clears it", () => {
		const onSave = vi.fn();
		render(
			<PlaylistWindowDialogForm
				initialStart={START} initialEnd={undefined}
				onSave={onSave} onCancel={vi.fn()}
			/>,
		);
		// Both checkboxes render (Start unchecked, End checked) — the second is
		// End's. Unchecking it seeds the default (08:40 display wall clock =
		// 12:40 UTC on the virtual clock).
		fireEvent.click(screen.getAllByLabelText("Not Time Bound")[1]);
		fireEvent.click(screen.getByRole("button", { name: "OK" }));
		expect(onSave).toHaveBeenCalledWith({ start: START, end: "2001-09-11T12:40:00.000Z" });
	});

	it("refuses an inverted window: OK disabled, reason shown", () => {
		const onSave = vi.fn();
		render(
			<PlaylistWindowDialogForm
				initialStart={END} initialEnd={START}
				onSave={onSave} onCancel={vi.fn()}
			/>,
		);
		expect(screen.getByText("The end must be after the start.")).not.toBeNull();
		const ok = screen.getByRole("button", { name: "OK" }) as HTMLButtonElement;
		expect(ok.disabled).toBe(true);
		fireEvent.click(ok);
		expect(onSave).not.toHaveBeenCalled();
	});

	it("cancel calls onCancel without saving", () => {
		const onSave = vi.fn();
		const onCancel = vi.fn();
		render(
			<PlaylistWindowDialogForm
				initialStart={undefined} initialEnd={undefined}
				onSave={onSave} onCancel={onCancel}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onCancel).toHaveBeenCalled();
		expect(onSave).not.toHaveBeenCalled();
	});
});
