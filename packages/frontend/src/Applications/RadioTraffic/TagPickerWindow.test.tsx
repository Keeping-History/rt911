import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TagDef } from "../../Providers/MediaStream/MediaStreamContext";

// ClassicyWindow needs the app-manager store to mount. The stub keeps the two
// things the shell is responsible for observable: the id/title it opens under,
// and the close box being wired to the same seam as Cancel.
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

import { TagPickerForm, TagPickerWindow } from "./TagPickerWindow";

// rt911 has no global test setup, so testing-library does not auto-clean the
// DOM between tests; do it explicitly to keep document-level queries isolated.
afterEach(cleanup);

/** A vocabulary row as the wire delivers it: `namespace:value` split out. */
function def(tag: string): TagDef {
	const i = tag.indexOf(":");
	return { tag, namespace: tag.slice(0, i), value: tag.slice(i + 1) };
}

const AIRCRAFT = [
	def("aircraft:aal11"),
	def("aircraft:ual175"),
	def("aircraft:aal77"),
	def("aircraft:ual93"),
	def("aircraft:n591ua"),
];

const boxes = () => screen.queryAllByRole("checkbox") as HTMLInputElement[];
const box = (value: string) => screen.getByLabelText(value) as HTMLInputElement;
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

const type = (query: string) =>
	fireEvent.change(screen.getByLabelText("Search"), { target: { value: query } });

const onConfirm = vi.fn();
const onCancel = vi.fn();
afterEach(() => {
	onConfirm.mockReset();
	onCancel.mockReset();
});

/** The tags reported by the single onConfirm call, sorted for comparison. */
function confirmed(): string[] {
	expect(onConfirm).toHaveBeenCalledTimes(1);
	return [...(onConfirm.mock.calls[0][0] as ReadonlySet<string>)].sort();
}

function renderForm(checked: string[] = [], values: TagDef[] = AIRCRAFT) {
	render(
		<TagPickerForm
			namespace="aircraft"
			label="Aircraft"
			values={values}
			checked={new Set(checked)}
			onConfirm={onConfirm}
			onCancel={onCancel}
		/>,
	);
}

describe("TagPickerForm", () => {
	it("lists every value in the namespace with a checkbox", () => {
		renderForm();
		expect(boxes()).toHaveLength(AIRCRAFT.length);
		for (const tag of AIRCRAFT) expect(box(tag.value as string)).not.toBeNull();
	});

	it("seeds the boxes from the tags already checked", () => {
		renderForm(["aircraft:aal11", "aircraft:ual93"]);
		expect(box("aal11").checked).toBe(true);
		expect(box("ual93").checked).toBe(true);
		expect(box("ual175").checked).toBe(false);
	});

	it("narrows the list as the query is typed", () => {
		renderForm();
		type("ual");
		// The two callsigns; the tail number n591ua stops one character short.
		expect(boxes()).toHaveLength(2);
		expect(screen.queryByLabelText("aal11")).toBeNull();

		// One character less and the tail number joins them, as a substring match.
		type("ua");
		expect(boxes()).toHaveLength(3);

		type("ual9");
		expect(boxes()).toHaveLength(1);
		expect(box("ual93")).not.toBeNull();
	});

	it("restores the full list when the query is cleared", () => {
		renderForm();
		type("ual93");
		expect(boxes()).toHaveLength(1);
		type("");
		expect(boxes()).toHaveLength(AIRCRAFT.length);
	});

	it("keeps a value checked after a new query filters it out of view", () => {
		// The failure this pins: pending state living in the rendered rows, so
		// narrowing unmounts the row and silently drops the tick with it.
		renderForm();

		type("aal");
		fireEvent.click(box("aal11"));
		type("ual");
		expect(screen.queryByLabelText("aal11")).toBeNull();
		fireEvent.click(box("ual93"));

		// Back in view, the earlier tick is still shown as ticked.
		type("aal");
		expect(box("aal11").checked).toBe(true);

		click("Confirm");
		expect(confirmed()).toEqual(["aircraft:aal11", "aircraft:ual93"]);
	});

	it("reports an unchecked value as removed", () => {
		renderForm(["aircraft:aal11", "aircraft:ual93"]);
		fireEvent.click(box("aal11"));
		click("Confirm");
		expect(confirmed()).toEqual(["aircraft:ual93"]);
	});

	it("leaves other namespaces' checked tags untouched", () => {
		// The picker owns one namespace but is handed the whole sidebar's set, so
		// confirming it must not clear the facility boxes the user ticked inline.
		renderForm(["facility:zbw", "topic:hijack"]);
		fireEvent.click(box("aal11"));
		click("Confirm");
		expect(confirmed()).toEqual(["aircraft:aal11", "facility:zbw", "topic:hijack"]);
	});

	it("discards pending changes on Cancel", () => {
		renderForm(["aircraft:aal11"]);

		fireEvent.click(box("ual175"));
		fireEvent.click(box("aal11"));
		click("Cancel");

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("confirms the set unchanged when nothing was touched", () => {
		renderForm(["aircraft:aal11"]);
		click("Confirm");
		expect(confirmed()).toEqual(["aircraft:aal11"]);
	});

	it("says so when a query matches nothing, rather than showing a blank panel", () => {
		renderForm();
		type("zzz");
		expect(boxes()).toEqual([]);
		expect(screen.getByText(/no matches/i)).not.toBeNull();
	});

	it("gives each checkbox an id scoped to its namespace", () => {
		// Two pickers can be open at once; a bare value as the DOM id would let
		// one window's label point at the other window's box.
		renderForm();
		expect(
			boxes().every((b) => b.id.startsWith("rt_tag_picker_aircraft_")),
		).toBe(true);
	});
});

describe("TagPickerWindow", () => {
	function renderWindow(namespace: string, label: string, values: TagDef[]) {
		render(
			<TagPickerWindow
				appId="RadioTraffic.app"
				icon="i.png"
				namespace={namespace}
				label={label}
				values={values}
				checked={new Set<string>()}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);
	}

	it("mounts the picker in a window of its own per namespace", () => {
		renderWindow("facility", "Facility", [def("facility:zbw")]);

		const win = screen.getByTestId("win-RadioTraffic.app_tag_picker_facility");
		expect(win.getAttribute("data-title")).toBe("Facility");
		expect(box("zbw")).not.toBeNull();

		fireEvent.click(box("zbw"));
		click("Confirm");
		expect(confirmed()).toEqual(["facility:zbw"]);
	});

	it("treats the close box as Cancel, not as Confirm", () => {
		// Closing a picker is a way out, not a way to apply — the sidebar must not
		// gain a filter the user never confirmed.
		renderWindow("person", "Person", [def("person:ong")]);
		fireEvent.click(box("ong"));
		fireEvent.click(screen.getByTestId("close-box"));

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});
});
