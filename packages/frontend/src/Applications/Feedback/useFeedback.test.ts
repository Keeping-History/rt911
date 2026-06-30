import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("html2canvas-pro", () => ({
	default: vi.fn(),
}));

vi.mock("../../openreplay", () => ({
	getSessionURL: vi.fn(),
}));

import html2canvas from "html2canvas-pro";
import { getSessionURL } from "../../openreplay";
import { useFeedback } from "./useFeedback";

const mockHtml2canvas = vi.mocked(html2canvas);
const mockGetSessionURL = vi.mocked(getSessionURL);

function makeFile(name: string, size = 100, type = "image/png"): File {
	const blob = new Blob([new Uint8Array(size)], { type });
	return new File([blob], name, { type });
}

describe("useFeedback", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		global.fetch = vi.fn();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("captureScreenshot", () => {
		it("calls html2canvas on #root with ignoreElements and returns a File named screenshot.png", async () => {
			const mockCanvas = {
				toBlob: (cb: (b: Blob | null) => void) =>
					cb(new Blob(["png"], { type: "image/png" })),
			} as unknown as HTMLCanvasElement;
			mockHtml2canvas.mockResolvedValue(mockCanvas);

			const root = document.createElement("div");
			root.id = "root";
			document.body.appendChild(root);

			const { result } = renderHook(() => useFeedback());
			let file!: File;
			await act(async () => {
				file = await result.current.captureScreenshot();
			});

			expect(mockHtml2canvas).toHaveBeenCalledWith(
				root,
				expect.objectContaining({ useCORS: true, ignoreElements: expect.any(Function) }),
			);
			expect(file.name).toBe("screenshot.png");
			expect(file.type).toBe("image/png");

			document.body.removeChild(root);
		});

		it("ignoreElements skips cross-origin iframes", async () => {
			const mockCanvas = {
				toBlob: (cb: (b: Blob | null) => void) =>
					cb(new Blob(["png"], { type: "image/png" })),
			} as unknown as HTMLCanvasElement;
			mockHtml2canvas.mockResolvedValue(mockCanvas);

			const root = document.createElement("div");
			root.id = "root";
			document.body.appendChild(root);

			const { result } = renderHook(() => useFeedback());
			await act(async () => {
				await result.current.captureScreenshot();
			});

			const { ignoreElements } = mockHtml2canvas.mock.calls[0][1] as {
				ignoreElements: (el: Element) => boolean;
			};

			const crossOriginIframe = document.createElement("iframe");
			crossOriginIframe.src = "https://other.example.com/page";
			expect(ignoreElements(crossOriginIframe)).toBe(true);

			const sameOriginIframe = document.createElement("iframe");
			sameOriginIframe.src = window.location.origin + "/page";
			expect(ignoreElements(sameOriginIframe)).toBe(false);

			const div = document.createElement("div");
			expect(ignoreElements(div)).toBe(false);

			document.body.removeChild(root);
		});
	});

	describe("submit", () => {
		const fields = {
			name:        "Test User",
			email:       "test@example.com",
			github:      "testuser",
			title:       "Something broke",
			description: "Here is what happened",
		};

		it("POSTs to VITE_FEEDBACK_URL/feedback with FormData containing all fields", async () => {
			vi.stubEnv("VITE_FEEDBACK_URL", "http://localhost:8080");
			mockGetSessionURL.mockReturnValue("https://openreplay.test/s/abc");
			vi.mocked(global.fetch).mockResolvedValue(
				new Response(JSON.stringify({ ok: true, issueUrl: "https://github.com/issues/1" }), { status: 200 }),
			);

			const { result } = renderHook(() => useFeedback());
			let issueUrl!: string;
			await act(async () => {
				issueUrl = await result.current.submit(fields, []);
			});

			expect(global.fetch).toHaveBeenCalledWith(
				"http://localhost:8080/feedback",
				expect.objectContaining({ method: "POST" }),
			);
			expect(issueUrl).toBe("https://github.com/issues/1");
		});

		it("includes attachments as FormData files", async () => {
			vi.stubEnv("VITE_FEEDBACK_URL", "http://localhost:8080");
			mockGetSessionURL.mockReturnValue(undefined);
			vi.mocked(global.fetch).mockResolvedValue(
				new Response(JSON.stringify({ ok: true, issueUrl: "https://github.com/issues/2" }), { status: 200 }),
			);

			const file = makeFile("shot.png");
			const { result } = renderHook(() => useFeedback());

			let capturedBody!: FormData;
			vi.mocked(global.fetch).mockImplementation(async (_url, init) => {
				capturedBody = init?.body as FormData;
				return new Response(JSON.stringify({ ok: true, issueUrl: "https://github.com/issues/2" }), { status: 200 });
			});

			await act(async () => {
				await result.current.submit(fields, [file]);
			});

			expect(capturedBody.get("attachments[]")).toBeTruthy();
		});

		it("sets submitting true during the request and false after", async () => {
			vi.stubEnv("VITE_FEEDBACK_URL", "http://localhost:8080");
			mockGetSessionURL.mockReturnValue(undefined);

			let resolveRequest!: (v: Response) => void;
			vi.mocked(global.fetch).mockReturnValue(
				new Promise<Response>((res) => { resolveRequest = res; }),
			);

			const { result } = renderHook(() => useFeedback());
			expect(result.current.state.submitting).toBe(false);

			let submitPromise!: Promise<string>;
			act(() => {
				submitPromise = result.current.submit(fields, []);
			});

			expect(result.current.state.submitting).toBe(true);

			await act(async () => {
				resolveRequest(
					new Response(JSON.stringify({ ok: true, issueUrl: "https://github.com/issues/3" }), { status: 200 }),
				);
				await submitPromise;
			});

			expect(result.current.state.submitting).toBe(false);
		});

		it("sets error state and throws when server returns non-200", async () => {
			vi.stubEnv("VITE_FEEDBACK_URL", "http://localhost:8080");
			mockGetSessionURL.mockReturnValue(undefined);
			vi.mocked(global.fetch).mockResolvedValue(
				new Response(JSON.stringify({ error: "missing required field: name" }), { status: 400 }),
			);

			const { result } = renderHook(() => useFeedback());

			await act(async () => {
				await expect(result.current.submit(fields, [])).rejects.toThrow("missing required field: name");
			});

			expect(result.current.state.error).toBe("missing required field: name");
			expect(result.current.state.submitting).toBe(false);
		});

		it("falls back to http://localhost:8080 when VITE_FEEDBACK_URL is unset", async () => {
			vi.stubEnv("VITE_FEEDBACK_URL", "");
			mockGetSessionURL.mockReturnValue(undefined);
			vi.mocked(global.fetch).mockResolvedValue(
				new Response(JSON.stringify({ ok: true, issueUrl: "https://github.com/issues/4" }), { status: 200 }),
			);

			const { result } = renderHook(() => useFeedback());
			await act(async () => {
				await result.current.submit(fields, []);
			});

			expect(vi.mocked(global.fetch)).toHaveBeenCalledWith(
				"http://localhost:8080/feedback",
				expect.anything(),
			);
		});
	});
});
