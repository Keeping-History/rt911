import { describe, expect, it, vi } from "vitest";
import { fetchStationLogos } from "./stationLogos";

function jsonResponse(data: unknown, ok = true, status = 200): Response {
	return {
		ok,
		status,
		json: async () => data,
	} as Response;
}

describe("fetchStationLogos", () => {
	it("maps source slug to image, first row winning per station", async () => {
		const fetchFn = vi.fn(async () =>
			jsonResponse({
				data: [
					{ source: { slug: "WCBS" }, image: "https://cdn.test/wcbs.png" },
					{ source: { slug: "WCBS" }, image: "https://cdn.test/other.png" },
					{ source: { slug: "KFI" }, image: "https://cdn.test/kfi.png" },
				],
			}),
		);
		expect(await fetchStationLogos(fetchFn as unknown as typeof fetch)).toEqual({
			WCBS: "https://cdn.test/wcbs.png",
			KFI: "https://cdn.test/kfi.png",
		});
	});

	it("skips rows with no slug or no image", async () => {
		const fetchFn = vi.fn(async () =>
			jsonResponse({
				data: [
					{ source: null, image: "https://cdn.test/orphan.png" },
					{ source: { slug: "WOR" }, image: null },
					{ source: { slug: "WOR" }, image: "https://cdn.test/wor.png" },
				],
			}),
		);
		expect(await fetchStationLogos(fetchFn as unknown as typeof fetch)).toEqual({
			WOR: "https://cdn.test/wor.png",
		});
	});

	// The `image` field sits behind a Directus public-read grant; if that grant
	// is ever narrowed the query 403s, and the tuner must degrade to text call
	// signs rather than break.
	it("resolves empty on a non-ok response", async () => {
		const fetchFn = vi.fn(async () => jsonResponse({}, false, 403));
		expect(await fetchStationLogos(fetchFn as unknown as typeof fetch)).toEqual({});
	});

	it("resolves empty when the request throws", async () => {
		const fetchFn = vi.fn(async () => {
			throw new Error("offline");
		});
		expect(await fetchStationLogos(fetchFn as unknown as typeof fetch)).toEqual({});
	});

	it("resolves empty when the body has no data array", async () => {
		const fetchFn = vi.fn(async () => jsonResponse({ errors: [{}] }));
		expect(await fetchStationLogos(fetchFn as unknown as typeof fetch)).toEqual({});
	});
});
