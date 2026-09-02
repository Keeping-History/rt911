import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeEvent, ReactNode } from "react";

// ClassicyWindow needs the app-manager store to mount — stub it the same way
// HyperCardItemPicker.test.tsx does. ClassicyPopUpMenu's real implementation
// is a custom listbox, not a native <select> — Weather.test.tsx's own stub
// (a real <select>) is the established, simpler-to-drive-in-tests shape.
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyWindow: ({ children, id, title }: { children?: ReactNode; id?: string; title?: string }) => (
		<div data-testid={`win-${id}`} data-title={title}>
			{children}
		</div>
	),
	ClassicyPopUpMenu: ({
		id,
		label,
		options,
		selected,
		onChangeFunc,
	}: {
		id: string;
		label?: string;
		options: Array<{ value: string; label: string }>;
		selected?: string;
		onChangeFunc?: (e: ChangeEvent<HTMLSelectElement>) => void;
	}) => (
		<label>
			{label}
			<select id={id} value={selected} onChange={(e) => onChangeFunc?.(e)}>
				{options.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
		</label>
	),
}));

const listRows = [
	{ id: 1, title: "WNYW", full_title: "WNYW Fox 5", source: "fox" },
	{ id: 2, title: "WCBS", full_title: "WCBS CBS 2", source: "cbs" },
	{ id: 3, title: "WABC", full_title: "WABC ABC 7", source: "abc" },
];
const fetchDirectusVideoList = vi.hoisted(() => vi.fn());
vi.mock("./directusCollections", () => ({ fetchDirectusVideoList }));

import { TVClipPicker } from "./TVClipPicker";

afterEach(() => {
	cleanup();
	fetchDirectusVideoList.mockReset();
});

describe("TVClipPicker", () => {
	it("shows '(none)' with no value, and the Browse control", () => {
		fetchDirectusVideoList.mockResolvedValue(listRows);
		render(<TVClipPicker value={undefined} onChange={vi.fn()} />);
		expect(screen.getByText("(none)")).toBeTruthy();
		expect(screen.getByRole("button", { name: /browse/i })).toBeTruthy();
	});

	it("shows a count summary for an existing array value", () => {
		fetchDirectusVideoList.mockResolvedValue(listRows);
		render(<TVClipPicker value={["1", "2"]} onChange={vi.fn()} />);
		expect(screen.getByText("2 selected")).toBeTruthy();
	});

	it("opens the picker, lists every channel, and confirms the selected ids", async () => {
		fetchDirectusVideoList.mockResolvedValue(listRows);
		const onChange = vi.fn();
		render(<TVClipPicker value={[]} onChange={onChange} />);
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		expect(await screen.findByLabelText("WNYW Fox 5")).toBeTruthy();
		expect(screen.getByLabelText("WCBS CBS 2")).toBeTruthy();
		expect(screen.getByLabelText("WABC ABC 7")).toBeTruthy();

		fireEvent.click(screen.getByLabelText("WNYW Fox 5"));
		fireEvent.click(screen.getByLabelText("WABC ABC 7"));
		fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

		expect(onChange).toHaveBeenCalledTimes(1);
		expect((onChange.mock.calls[0][0] as string[]).sort()).toEqual(["1", "3"]);
	});

	it("filters the list by network via the pop-up", async () => {
		fetchDirectusVideoList.mockResolvedValue(listRows);
		render(<TVClipPicker value={[]} onChange={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		await screen.findByLabelText("WNYW Fox 5");

		fireEvent.change(screen.getByLabelText("Network"), { target: { value: "cbs" } });
		await screen.findByLabelText("WCBS CBS 2");
		expect(screen.queryByLabelText("WNYW Fox 5")).toBeNull();
		expect(screen.queryByLabelText("WABC ABC 7")).toBeNull();
	});

	it("does not call onChange on Cancel", async () => {
		fetchDirectusVideoList.mockResolvedValue(listRows);
		const onChange = vi.fn();
		render(<TVClipPicker value={[]} onChange={onChange} />);
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		await screen.findByLabelText("WNYW Fox 5");
		act(() => {
			fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
		});
		expect(onChange).not.toHaveBeenCalled();
	});
});
