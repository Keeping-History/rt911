import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// jsdom has no ResizeObserver; the real component instantiates one on mount.
vi.stubGlobal(
	"ResizeObserver",
	class {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
);

import Marquee from "./marquee";

describe("marquee interop shim", () => {
	it("exports a renderable component whatever CJS interop shape Vite hands us", () => {
		// With the raw default import under rolldown-vite this throws
		// "Element type is invalid ... got: object" — the shim must unwrap it.
		render(
			<Marquee speed={40}>
				<span>tick</span>
			</Marquee>,
		);
		expect(screen.getAllByText("tick").length).toBeGreaterThan(0);
	});
});
