import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BookmarkDisclosure } from "./BookmarkDisclosure";

afterEach(cleanup);

describe("BookmarkDisclosure", () => {
	it("shows children when defaultOpen", () => {
		render(<BookmarkDisclosure label="Global" defaultOpen><div>child</div></BookmarkDisclosure>);
		const header = screen.getByRole("button", { name: /Global/ });
		expect(header.getAttribute("aria-expanded")).toBe("true");
	});
	it("toggles open state on click", () => {
		render(<BookmarkDisclosure label="Personal"><div>child</div></BookmarkDisclosure>);
		const header = screen.getByRole("button", { name: /Personal/ });
		expect(header.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(header);
		expect(header.getAttribute("aria-expanded")).toBe("true");
	});
});
