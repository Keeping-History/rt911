import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// Deterministic registry: the real one reads whatever contexts happen to have
// registered, which depends on import order across the whole suite.
vi.mock("./settingsRegistry", async (importOriginal) => ({
	...(await importOriginal<typeof import("./settingsRegistry")>()),
	listSettingsApps: () => [
		{ appId: "TV.app", name: "TV" },
		{ appId: "Weather.app", name: "Weather" },
	],
	settingsFieldsOf: (appId: string) =>
		appId === "TV.app"
			? [
					{ key: "captionsOn", description: "Whether closed captions are shown.", control: "boolean" },
					{ key: "volumeLimit", control: "number" },
					{ key: "channelOrder", control: "json" },
				]
			: [],
}));

// The popup menu is a custom button+listbox; a native select keeps the app
// switch drivable with one change event while the wiring under test stays ours.
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyPopUpMenu: ({
		id, label, options, selected, onChangeFunc,
	}: {
		id: string;
		label?: string;
		options: { value: string; label: string }[];
		selected?: string;
		onChangeFunc?: (e: { target: { value: string } }) => void;
	}) => (
		<select
			id={id}
			aria-label={label ?? id}
			value={selected}
			onChange={(e) => onChangeFunc?.({ target: { value: e.target.value } })}
		>
			{options.map((o) => (
				<option key={o.value} value={o.value}>{o.label}</option>
			))}
		</select>
	),
}));

import { EntryForm } from "./EntryForm";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("EntryForm", () => {
	it("edits a media entry's focus mode", () => {
		const onChange = vi.fn();
		render(
			<EntryForm
				value={{ uid: "e1", entry: { kind: "media", app: "tv", itemId: "ABC" } }}
				onChange={onChange}
			/>,
		);
		fireEvent.change(screen.getByRole("combobox", { name: /focus/i }), { target: { value: "locked" } });
		expect(onChange).toHaveBeenCalledWith({ kind: "media", app: "tv", itemId: "ABC", focus: "locked" });
	});

	it("offers the registered apps and resets values when the app switches", () => {
		const onChange = vi.fn();
		render(
			<EntryForm
				value={{ uid: "e1", entry: { kind: "settings", appId: "TV.app", values: { captionsOn: true } } }}
				onChange={onChange}
			/>,
		);
		const picker = screen.getByRole("combobox", { name: "App" });
		expect(Array.from((picker as HTMLSelectElement).options).map((o) => o.textContent))
			.toEqual(["TV", "Weather"]);

		fireEvent.change(picker, { target: { value: "Weather.app" } });
		// The old values belong to TV's schema, so switching drops them.
		expect(onChange).toHaveBeenCalledWith({
			kind: "settings", appId: "Weather.app", values: {},
		});
	});

	it("includes a schema field via its checkbox and removes it when unchecked", () => {
		const onChange = vi.fn();
		const { rerender } = render(
			<EntryForm
				value={{ uid: "e1", entry: { kind: "settings", appId: "TV.app", values: {} } }}
				onChange={onChange}
			/>,
		);
		fireEvent.click(screen.getByLabelText("captionsOn"));
		expect(onChange).toHaveBeenCalledWith({
			kind: "settings", appId: "TV.app", values: { captionsOn: false },
		});

		rerender(
			<EntryForm
				value={{ uid: "e1", entry: { kind: "settings", appId: "TV.app", values: { captionsOn: false } } }}
				onChange={onChange}
			/>,
		);
		fireEvent.click(screen.getByLabelText("captionsOn"));
		expect(onChange).toHaveBeenLastCalledWith({
			kind: "settings", appId: "TV.app", values: {},
		});
	});

	it("edits an included boolean field's forced value", () => {
		const onChange = vi.fn();
		render(
			<EntryForm
				value={{ uid: "e1", entry: { kind: "settings", appId: "TV.app", values: { captionsOn: false } } }}
				onChange={onChange}
			/>,
		);
		fireEvent.click(screen.getByLabelText("on"));
		expect(onChange).toHaveBeenCalledWith({
			kind: "settings", appId: "TV.app", values: { captionsOn: true },
		});
	});

	it("edits an included number field", () => {
		const onChange = vi.fn();
		render(
			<EntryForm
				value={{ uid: "e1", entry: { kind: "settings", appId: "TV.app", values: { volumeLimit: 0.5 } } }}
				onChange={onChange}
			/>,
		);
		// The lone number input in the form: a native number field has the
		// spinbutton role, so no label plumbing is needed to reach it.
		fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0.8" } });
		expect(onChange).toHaveBeenCalledWith({
			kind: "settings", appId: "TV.app", values: { volumeLimit: 0.8 },
		});
	});

	it("flags invalid JSON in a complex field on blur without applying it", () => {
		const onChange = vi.fn();
		render(
			<EntryForm
				value={{ uid: "e1", entry: { kind: "settings", appId: "TV.app", values: { channelOrder: [] } } }}
				onChange={onChange}
			/>,
		);
		const area = screen.getByRole("textbox", { name: /channelOrder value/i });
		fireEvent.change(area, { target: { value: "{not json" } });
		fireEvent.blur(area);
		expect(screen.getByText(/invalid JSON/i)).not.toBeNull();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("says so when the chosen app declares no settings", () => {
		render(
			<EntryForm
				value={{ uid: "e1", entry: { kind: "settings", appId: "Weather.app", values: {} } }}
				onChange={vi.fn()}
			/>,
		);
		expect(screen.getByText(/declares no settings/i)).not.toBeNull();
	});

	it("edits a browser entry's url", () => {
		const onChange = vi.fn();
		render(
			<EntryForm
				value={{ uid: "e1", entry: { kind: "browser", url: "http://cnn.com", at: "2001-09-11T13:00:00.000Z" } }}
				onChange={onChange}
			/>,
		);
		fireEvent.change(screen.getByRole("textbox", { name: /url/i }), { target: { value: "http://nyt.com" } });
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ url: "http://nyt.com" }));
	});

	it("renders date+time pickers for a freshly added jump entry (at/to both unset)", () => {
		const onChange = vi.fn();
		render(
			<EntryForm
				value={{ uid: "e1", entry: { kind: "jump", at: "", to: "" } }}
				onChange={onChange}
			/>,
		);
		// Required fields must render pickers even though there's no value yet.
		expect(document.getElementById("When clock reaches-date_month")).not.toBeNull();
		expect(document.getElementById("When clock reaches-time_hour")).not.toBeNull();
		expect(document.getElementById("Jump to-date_month")).not.toBeNull();
		expect(document.getElementById("Jump to-time_hour")).not.toBeNull();
	});

	it("fires onChange with a UTC ISO string when the 'When clock reaches' time picker is used", () => {
		const onChange = vi.fn();
		render(
			<EntryForm
				value={{ uid: "e1", entry: { kind: "jump", at: "", to: "" } }}
				onChange={onChange}
			/>,
		);
		const minutes = document.getElementById("When clock reaches-time_minutes") as HTMLInputElement;
		fireEvent.change(minutes, { target: { value: "45" } });
		expect(onChange).toHaveBeenCalled();
		const call = onChange.mock.calls.at(-1)?.[0] as { at: string };
		expect(typeof call.at).toBe("string");
		expect(call.at.length).toBeGreaterThan(0);
		expect(new Date(call.at).toString()).not.toBe("Invalid Date");
	});
});
