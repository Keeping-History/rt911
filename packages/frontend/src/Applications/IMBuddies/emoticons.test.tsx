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
		const el = shown("im scared :-(");
		expect(el.textContent).toContain("im scared");
		expect(el.querySelectorAll("[data-emoticon]")).toHaveLength(1);
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
		const el = shown("just words");
		expect(el.textContent).toBe("just words");
		expect(el.querySelectorAll("[data-emoticon]")).toHaveLength(0);
	});

	it("renders an emoticon followed by a period", () => {
		const el = shown("see you soon :-).");
		expect(el.querySelectorAll("[data-emoticon]")).toHaveLength(1);
	});

	it("renders an emoticon followed by a comma", () => {
		const el = shown("lol :-)," );
		expect(el.querySelectorAll("[data-emoticon]")).toHaveLength(1);
	});

	it("renders an emoticon followed by a question mark", () => {
		const el = shown("what :-)?");
		expect(el.querySelectorAll("[data-emoticon]")).toHaveLength(1);
	});

	it("renders an emoticon followed by an exclamation mark", () => {
		const el = shown("yes :-O!");
		expect(el.querySelectorAll("[data-emoticon]")).toHaveLength(1);
	});

	it("still does not fire on colon-paren inside a word after fix", () => {
		const el = shown("meet at 8:30");
		expect(el.querySelectorAll("[data-emoticon]")).toHaveLength(0);
		expect(el.textContent).toBe("meet at 8:30");
	});

	it("still does not fire on colon-digit inside a word (3:1 ratio)", () => {
		const el = shown("ratio is 3:1");
		expect(el.querySelectorAll("[data-emoticon]")).toHaveLength(0);
		expect(el.textContent).toBe("ratio is 3:1");
	});
});
