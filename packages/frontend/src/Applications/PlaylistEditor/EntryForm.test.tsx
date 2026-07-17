import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

	it("flags invalid settings JSON on blur without calling onChange", () => {
		const onChange = vi.fn();
		render(
			<EntryForm
				value={{ uid: "e1", entry: { kind: "settings", appId: "TV.app", values: {} } }}
				onChange={onChange}
			/>,
		);
		const area = screen.getByRole("textbox", { name: /values/i });
		fireEvent.change(area, { target: { value: "{not json" } });
		fireEvent.blur(area);
		expect(screen.getByText(/invalid JSON/i)).not.toBeNull();
		expect(onChange).not.toHaveBeenCalled();
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
