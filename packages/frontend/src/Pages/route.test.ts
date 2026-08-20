import { describe, expect, it } from "vitest";
import { pagesRouteSlug, RESERVED_PATHS } from "./route";

describe("pagesRouteSlug", () => {
	it("resolves a single-segment path to its slug", () => {
		expect(pagesRouteSlug("/about")).toBe("about");
		expect(pagesRouteSlug("/about/")).toBe("about");
		expect(pagesRouteSlug("/hidden-example")).toBe("hidden-example");
	});

	// The desktop owns the root; routing it to Pages would replace the product.
	it("returns null for the root", () => {
		expect(pagesRouteSlug("/")).toBeNull();
		expect(pagesRouteSlug("")).toBeNull();
	});

	it("returns null for every reserved path", () => {
		for (const reserved of RESERVED_PATHS) {
			expect(pagesRouteSlug(`/${reserved}`)).toBeNull();
		}
	});

	// Slugs are flat by design: `parent` groups the menu, not the URL.
	it("returns null for multi-segment paths", () => {
		expect(pagesRouteSlug("/about/team")).toBeNull();
		expect(pagesRouteSlug("/img/events/photo")).toBeNull();
	});

	it("returns null for anything that looks like a file", () => {
		expect(pagesRouteSlug("/index.html")).toBeNull();
		expect(pagesRouteSlug("/favicon.ico")).toBeNull();
		expect(pagesRouteSlug("/50x.html")).toBeNull();
	});

	it("decodes percent-encoding and survives malformed input", () => {
		expect(pagesRouteSlug("/caf%C3%A9")).toBe("café");
		expect(pagesRouteSlug("/%E0%A4%A")).toBeNull();
	});

	// The reserved list is the frontend half of a contract with Directus; if it
	// empties out, every docroot path becomes shadowable.
	it("keeps a non-empty reserved list", () => {
		expect(RESERVED_PATHS.length).toBeGreaterThan(0);
		expect(RESERVED_PATHS).toContain("assets");
	});
});
