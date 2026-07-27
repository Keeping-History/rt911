import { describe, expect, it } from "vitest";
import { chatHttpBase, fromEnv } from "./endpoints";

describe("fromEnv", () => {
	it("uses the configured value when one is set", () => {
		expect(fromEnv("https://api.example.org", "https://fallback.example")).toBe(
			"https://api.example.org",
		);
	});

	it("falls back when the variable is undefined", () => {
		expect(fromEnv(undefined, "https://fallback.example")).toBe("https://fallback.example");
	});

	// The case that matters in production: the Dockerfile's ENV VITE_X=$VITE_X
	// assigns "" when the build arg was never passed, so an empty string has to
	// mean absent. Treating it as present yields a relative URL that quietly
	// targets the page's own origin.
	it("falls back on an empty string, not just on undefined", () => {
		expect(fromEnv("", "https://fallback.example")).toBe("https://fallback.example");
	});
});

describe("chatHttpBase", () => {
	it("converts a wss stream URL to an https base", () => {
		expect(chatHttpBase("wss://stream.911realtime.org/stream")).toBe(
			"https://stream.911realtime.org",
		);
	});

	it("converts a plain ws URL to http for local development", () => {
		expect(chatHttpBase("ws://localhost:8080/stream")).toBe("http://localhost:8080");
	});

	// The rewrite must not fire on a host that merely starts with "ws".
	it("only rewrites the scheme, never the host", () => {
		expect(chatHttpBase("wss://ws.example.org/stream")).toBe("https://ws.example.org");
	});

	// Only a trailing /stream is the path to strip.
	it("leaves a stream segment alone when it is not the final path element", () => {
		expect(chatHttpBase("wss://example.org/stream/v2")).toBe("https://example.org/stream/v2");
	});
});
