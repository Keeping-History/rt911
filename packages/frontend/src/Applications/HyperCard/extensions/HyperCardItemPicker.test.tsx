import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ClassicyWindow needs the app-manager store to mount — stub the two things
// the shell is responsible for (same shape as TagPickerWindow.test.tsx).
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyWindow: ({
		children,
		id,
		title,
		onCloseFunc,
	}: {
		children?: React.ReactNode;
		id?: string;
		title?: string;
		onCloseFunc?: (id: string) => void;
	}) => (
		<div data-testid={`win-${id}`} data-title={title}>
			<button type="button" data-testid="close-box" onClick={() => onCloseFunc?.(id ?? "")}>
				close
			</button>
			{children}
		</div>
	),
}));

import {
	filterRowsByQuery,
	HyperCardItemPicker,
	HyperCardItemPickerForm,
	type HyperCardItemPickerRow,
} from "./HyperCardItemPicker";

afterEach(cleanup);

interface Row extends HyperCardItemPickerRow {
	extra?: string;
}

const ROWS: Row[] = [
	{ id: "1", label: "AAL11" },
	{ id: "2", label: "UAL175" },
	{ id: "3", label: "AAL77" },
	{ id: "4", label: "UAL93" },
];

const onConfirm = vi.fn();
const onCancel = vi.fn();
afterEach(() => {
	onConfirm.mockReset();
	onCancel.mockReset();
});

const box = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
// Mode varies test-to-test (checkbox in multi mode, radio in single mode);
// getByRole only accepts one literal role, so query the raw <input> elements.
const boxes = () => Array.from(document.querySelectorAll<HTMLInputElement>("input[type=checkbox], input[type=radio]"));
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const type = (query: string) =>
	fireEvent.change(screen.getByLabelText("Search"), { target: { value: query } });

function renderForm(overrides: Partial<Parameters<typeof HyperCardItemPickerForm<Row>>[0]> = {}) {
	const fetchItems = vi.fn((query: string) => filterRowsByQuery(ROWS, query));
	render(
		<HyperCardItemPickerForm
			pickerKey="test"
			title="Test Picker"
			selectionMode="multi"
			selected={[]}
			fetchItems={fetchItems}
			onConfirm={onConfirm}
			onCancel={onCancel}
			{...overrides}
		/>,
	);
	return fetchItems;
}

describe("filterRowsByQuery", () => {
	it("ranks prefix matches before substring matches, case-insensitively", () => {
		expect(filterRowsByQuery(ROWS, "ual").map((r) => r.id)).toEqual(["2", "4"]);
	});

	it("returns everything unfiltered for a blank query", () => {
		expect(filterRowsByQuery(ROWS, "")).toEqual(ROWS);
	});

	it("returns nothing for a query matching no label", () => {
		expect(filterRowsByQuery(ROWS, "zzz")).toEqual([]);
	});
});

describe("HyperCardItemPickerForm", () => {
	it("lists every row fetchItems returns", async () => {
		renderForm();
		expect(await screen.findByLabelText("AAL11")).toBeTruthy();
		expect(boxes()).toHaveLength(ROWS.length);
	});

	it("re-queries fetchItems as the search box changes", async () => {
		const fetchItems = renderForm();
		await screen.findByLabelText("AAL11");
		type("ual");
		await screen.findByLabelText("UAL175");
		expect(boxes()).toHaveLength(2);
		expect(fetchItems).toHaveBeenLastCalledWith("ual", {});
	});

	it("keeps a row checked after a new query filters it out of view (multi)", async () => {
		renderForm();
		await screen.findByLabelText("AAL11");
		fireEvent.click(box("AAL11"));
		type("ual");
		await screen.findByLabelText("UAL175");
		expect(screen.queryByLabelText("AAL11")).toBeNull();
		fireEvent.click(box("UAL93"));

		type("");
		await screen.findByLabelText("AAL11");
		expect(box("AAL11").checked).toBe(true);
		expect(box("UAL93").checked).toBe(true);

		click("Confirm");
		expect(onConfirm).toHaveBeenCalledWith(expect.arrayContaining(["1", "4"]));
		expect((onConfirm.mock.calls[0][0] as string[]).sort()).toEqual(["1", "4"]);
	});

	it("seeds pending selection from `selected`", async () => {
		renderForm({ selected: ["1", "3"] });
		await screen.findByLabelText("AAL11");
		expect(box("AAL11").checked).toBe(true);
		expect(box("AAL77").checked).toBe(true);
		expect(box("UAL175").checked).toBe(false);
	});

	it("caps selection at one row in single mode", async () => {
		renderForm({ selectionMode: "single" });
		await screen.findByLabelText("AAL11");
		fireEvent.click(box("AAL11"));
		fireEvent.click(box("UAL175"));
		click("Confirm");
		expect(onConfirm).toHaveBeenCalledWith(["2"]);
	});

	it("discards pending changes on Cancel", async () => {
		renderForm();
		await screen.findByLabelText("AAL11");
		fireEvent.click(box("AAL11"));
		click("Cancel");
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("shows an empty-state message rather than a blank panel", async () => {
		renderForm();
		type("zzz");
		expect(await screen.findByText(/no matches/i)).toBeTruthy();
	});

	it("shows a custom empty message when given one", async () => {
		renderForm({ emptyMessage: "No flights right now." });
		type("zzz");
		expect(await screen.findByText("No flights right now.")).toBeTruthy();
	});

	it("shows an error state when fetchItems rejects", async () => {
		render(
			<HyperCardItemPickerForm
				pickerKey="test"
				title="Test Picker"
				selectionMode="multi"
				selected={[]}
				fetchItems={() => Promise.reject(new Error("boom"))}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);
		expect(await screen.findByRole("alert")).toBeTruthy();
	});

	it("uses renderRow for custom row content instead of the bare label", async () => {
		renderForm({
			renderRow: (row) => <span data-testid={`row-${row.id}`}>Flight {row.label}</span>,
		});
		expect((await screen.findByTestId("row-1")).textContent).toBe("Flight AAL11");
	});

	it("passes filter state through to fetchItems and lets renderFilterBar update it", async () => {
		const fetchItems = vi.fn((_query: string, filters: Record<string, unknown>) =>
			ROWS.filter((r) => !filters.onlyUal || r.label.startsWith("UAL")),
		);
		render(
			<HyperCardItemPickerForm
				pickerKey="test"
				title="Test Picker"
				selectionMode="multi"
				selected={[]}
				initialFilters={{ onlyUal: false }}
				fetchItems={fetchItems}
				renderFilterBar={(filters, setFilters) => (
					<button
						type="button"
						onClick={() => setFilters({ onlyUal: !filters.onlyUal })}
					>
						Toggle UAL-only
					</button>
				)}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);
		await screen.findByLabelText("AAL11");
		expect(boxes()).toHaveLength(4);
		click("Toggle UAL-only");
		await screen.findByLabelText("UAL175");
		expect(boxes()).toHaveLength(2);
		expect(fetchItems).toHaveBeenLastCalledWith("", { onlyUal: true });
	});
});

describe("HyperCardItemPicker", () => {
	it("mounts the form inside a window scoped by pickerKey", async () => {
		render(
			<HyperCardItemPicker
				appId="HyperCard.app"
				pickerKey="tv_clip"
				title="Choose TV Channels"
				selectionMode="multi"
				selected={[]}
				fetchItems={() => ROWS}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);
		const win = screen.getByTestId("win-HyperCard.app_item_picker_tv_clip");
		expect(win.getAttribute("data-title")).toBe("Choose TV Channels");
		expect(await screen.findByLabelText("AAL11")).toBeTruthy();
	});

	it("treats the close box as Cancel, not as Confirm", async () => {
		render(
			<HyperCardItemPicker
				appId="HyperCard.app"
				pickerKey="tv_clip"
				title="Choose TV Channels"
				selectionMode="multi"
				selected={[]}
				fetchItems={() => ROWS}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);
		await screen.findByLabelText("AAL11");
		act(() => {
			fireEvent.click(screen.getByTestId("close-box"));
		});
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});
});
