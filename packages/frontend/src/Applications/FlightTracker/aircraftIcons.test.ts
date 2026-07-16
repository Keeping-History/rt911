import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAircraftIconSvg, resetAircraftIconCache } from "./aircraftIcons";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0Z"/></svg>';

const okResponse = () =>
	({ ok: true, text: async () => SVG }) as unknown as Response;

describe("loadAircraftIconSvg", () => {
	afterEach(() => {
		resetAircraftIconCache();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("fetches the family's icon SVG from the icons path", async () => {
		const fetchMock = vi.fn(async () => okResponse());
		vi.stubGlobal("fetch", fetchMock);
		const svg = await loadAircraftIconSvg("b767");
		expect(svg).toBe(SVG);
		expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/icons\/b767\.svg$/));
	});

	it("caches per family — second call does not refetch", async () => {
		const fetchMock = vi.fn(async () => okResponse());
		vi.stubGlobal("fetch", fetchMock);
		await loadAircraftIconSvg("b757");
		await loadAircraftIconSvg("b757");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("resolves null on HTTP failure without throwing, and caches the failure", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response);
		vi.stubGlobal("fetch", fetchMock);
		expect(await loadAircraftIconSvg("crj")).toBeNull();
		expect(await loadAircraftIconSvg("crj")).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("resolves null on network error", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
		expect(await loadAircraftIconSvg("atr")).toBeNull();
	});

	it("reset seam forgets settled loads", async () => {
		const fetchMock = vi.fn(async () => okResponse());
		vi.stubGlobal("fetch", fetchMock);
		await loadAircraftIconSvg("dc10");
		resetAircraftIconCache();
		await loadAircraftIconSvg("dc10");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
