import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Disclosure } from "./Disclosure";

afterEach(cleanup);

describe("Disclosure", () => {
	it("shows children when defaultOpen", () => {
		render(<Disclosure label="Global" defaultOpen><div>child</div></Disclosure>);
		const header = screen.getByRole("button", { name: /Global/ });
		expect(header.getAttribute("aria-expanded")).toBe("true");
	});
	it("toggles open state on click", () => {
		render(<Disclosure label="Personal"><div>child</div></Disclosure>);
		const header = screen.getByRole("button", { name: /Personal/ });
		expect(header.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(header);
		expect(header.getAttribute("aria-expanded")).toBe("true");
	});
});
