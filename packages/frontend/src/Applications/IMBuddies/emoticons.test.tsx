import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { renderEmoticons } from "./emoticons";

afterEach(cleanup);

const shown = (text: string) => {
	render(<p data-testid="out">{renderEmoticons(text)}</p>);
	return screen.getByTestId("out");
};

describe("renderEmoticons", () => {
	it("replaces a known emoticon with a graphic", () => {
		expect(shown("im scared :-(").querySelectorAll("[data-emoticon]")).toHaveLength(1);
	});

	it("keeps the surrounding words intact", () => {
		expect(shown("im scared :-(").textContent).toContain("im scared");
	});

	it("leaves an unmapped token as typed", () => {
		const el = shown("what :-P");
		expect(el.querySelectorAll("[data-emoticon]")).toHaveLength(0);
		expect(el.textContent).toBe("what :-P");
	});

	it("does not fire inside a word", () => {
		// A URL or a timestamp must not sprout a face. Sanitize strips URLs, but
		// "8:30" reaching this must stay text.
		const el = shown("meet at 8:30");
		expect(el.querySelectorAll("[data-emoticon]")).toHaveLength(0);
	});

	it("handles several in one message", () => {
		expect(shown(":-) hi :-)").querySelectorAll("[data-emoticon]")).toHaveLength(2);
	});

	it("returns plain text unchanged", () => {
		expect(shown("just words").textContent).toBe("just words");
	});
});
