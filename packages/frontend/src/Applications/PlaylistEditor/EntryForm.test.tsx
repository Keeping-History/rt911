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
});
