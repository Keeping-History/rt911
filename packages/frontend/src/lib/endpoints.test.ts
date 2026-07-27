import { describe, expect, it } from "vitest";
import { chatHttpBase } from "./endpoints";

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
