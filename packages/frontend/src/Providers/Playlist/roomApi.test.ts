import { describe, expect, it, vi } from "vitest";
import { ROOM_BASE } from "../../lib/endpoints";
import {
	RoomCommandError, sendRoomFocus, sendRoomJump, sendRoomLock, sendRoomMessage,
	sendRoomReload,
} from "./roomApi";

const ok = () => new Response(null, { status: 202 });

describe("sendRoomLock", () => {
	it("posts the lock command to the streamer", async () => {
		const f = vi.fn().mockResolvedValue(ok());
		await sendRoomLock("p1", "clock", true, f as unknown as typeof fetch);

		const [url, init] = f.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${ROOM_BASE}/room`);
		expect(init.method).toBe("POST");
		expect(JSON.parse(String(init.body))).toEqual({
			room: "p1",
			action: "lock",
			target: "clock",
			on: true,
		});
	});

	// The streamer authorises by resolving the Directus session cookie to the
	// playlist's creator, so omitting credentials makes every call a 401.
	it("sends the session cookie", async () => {
		const f = vi.fn().mockResolvedValue(ok());
		await sendRoomLock("p1", "clock", true, f as unknown as typeof fetch);
		expect((f.mock.calls[0][1] as RequestInit).credentials).toBe("include");
	});

	it("sends on:false for an unlock rather than omitting it", async () => {
		const f = vi.fn().mockResolvedValue(ok());
		await sendRoomLock("p1", "clock", false, f as unknown as typeof fetch);
		const body = JSON.parse(String((f.mock.calls[0][1] as RequestInit).body));
		expect(body.on).toBe(false);
		expect("on" in body).toBe(true);
	});

	it.each([
		[401, "Sign in to control this playlist."],
		[403, "Only the person who created this playlist can control it."],
		[429, "Too many commands — wait a moment."],
	])("explains a %i", async (status, message) => {
		const f = vi.fn().mockResolvedValue(new Response(null, { status }));
		await expect(sendRoomLock("p1", "clock", true, f as unknown as typeof fetch)).rejects.toThrow(
			message,
		);
	});

	it("reports an unreachable server rather than throwing a raw network error", async () => {
		const f = vi.fn().mockRejectedValue(new TypeError("network"));
		await expect(
			sendRoomLock("p1", "clock", true, f as unknown as typeof fetch),
		).rejects.toBeInstanceOf(RoomCommandError);
	});
});

describe("sendRoomReload", () => {
	// Reload deliberately has no payload: students re-fetch the published
	// definition from Directus themselves — it never rides the wire.
	it("posts the bare reload command to the streamer", async () => {
		const f = vi.fn().mockResolvedValue(ok());
		await sendRoomReload("p1", f as unknown as typeof fetch);

		const [url, init] = f.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${ROOM_BASE}/room`);
		expect(init.method).toBe("POST");
		expect(init.credentials).toBe("include");
		expect(JSON.parse(String(init.body))).toEqual({ room: "p1", action: "reload" });
	});

	it.each([
		[401, "Sign in to control this playlist."],
		[403, "Only the person who created this playlist can control it."],
		[429, "Too many commands — wait a moment."],
	])("explains a %i", async (status, message) => {
		const f = vi.fn().mockResolvedValue(new Response(null, { status }));
		await expect(sendRoomReload("p1", f as unknown as typeof fetch)).rejects.toThrow(message);
	});

	it("reports an unreachable server rather than throwing a raw network error", async () => {
		const f = vi.fn().mockRejectedValue(new TypeError("network"));
		await expect(sendRoomReload("p1", f as unknown as typeof fetch)).rejects.toBeInstanceOf(
			RoomCommandError,
		);
	});
});

// The three teacher one-shots share postRoomCommand with lock/reload (whose
// suites above already pin credentials and the error mapping), so each needs
// only its body shape pinned here.
describe("teacher one-shot commands", () => {
	it("sendRoomJump posts the jump with its UTC instant", async () => {
		const f = vi.fn().mockResolvedValue(ok());
		await sendRoomJump("p1", "2001-09-11T13:03:00.000Z", f as unknown as typeof fetch);
		expect(JSON.parse(String((f.mock.calls[0][1] as RequestInit).body))).toEqual({
			room: "p1",
			action: "jump",
			time: "2001-09-11T13:03:00.000Z",
		});
	});

	it("sendRoomFocus posts the app to bring to front", async () => {
		const f = vi.fn().mockResolvedValue(ok());
		await sendRoomFocus("p1", "TV.app", f as unknown as typeof fetch);
		expect(JSON.parse(String((f.mock.calls[0][1] as RequestInit).body))).toEqual({
			room: "p1",
			action: "focus",
			app: "TV.app",
		});
	});

	it("sendRoomMessage posts the note body", async () => {
		const f = vi.fn().mockResolvedValue(ok());
		await sendRoomMessage("p1", "Look at channel 4", f as unknown as typeof fetch);
		expect(JSON.parse(String((f.mock.calls[0][1] as RequestInit).body))).toEqual({
			room: "p1",
			action: "message",
			message: "Look at channel 4",
		});
	});

	it("maps a refusal to the shared human-readable reason", async () => {
		const f = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
		await expect(
			sendRoomJump("p1", "2001-09-11T13:03:00.000Z", f as unknown as typeof fetch),
		).rejects.toThrow("Only the person who created this playlist can control it.");
	});
});
