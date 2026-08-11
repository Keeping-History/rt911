import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomCommand } from "../MediaStream/MediaStreamContext";

const hooks = vi.hoisted(() => ({
	setDateTime: undefined as unknown as ReturnType<typeof vi.fn>,
	dispatch: undefined as unknown as ReturnType<typeof vi.fn>,
	locked: false,
}));

vi.mock("classicy", () => ({
	// playlistAppMeta reads the icon registry; an empty one is enough — this
	// suite asserts on the dispatched app id, not its chrome.
	ClassicyIcons: { applications: {} },
	useClassicyDateTime: () => ({ setDateTime: hooks.setDateTime }),
	useAppManagerDispatch: () => hooks.dispatch,
	useAppManager: (sel: (s: unknown) => unknown) =>
		sel({ System: { Manager: { DateAndTime: { dateTimeLocked: hooks.locked } } } }),
	ClassicyApp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
	ClassicyAlert: ({ label, message }: { label: string; message: React.ReactNode }) => (
		<div>
			<h1>{label}</h1>
			<div>{message}</div>
		</div>
	),
}));

import { MediaStreamContext } from "../MediaStream/MediaStreamContext";
import { RoomControlBridge } from "./RoomControlBridge";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function mount(roomCommand: RoomCommand | null, locked = false) {
	hooks.setDateTime = vi.fn();
	hooks.dispatch = vi.fn();
	hooks.locked = locked;
	const value = { roomCommand } as unknown as React.ContextType<typeof MediaStreamContext>;
	const view = render(
		<MediaStreamContext.Provider value={value}>
			<RoomControlBridge />
		</MediaStreamContext.Provider>,
	);
	return (next: RoomCommand | null) =>
		view.rerender(
			<MediaStreamContext.Provider
				value={{ roomCommand: next } as unknown as React.ContextType<typeof MediaStreamContext>}
			>
				<RoomControlBridge />
			</MediaStreamContext.Provider>,
		);
}

describe("RoomControlBridge", () => {
	it("applies a jump through the sanctioned clock seam", () => {
		mount({ action: "jump", time: "2001-09-11T13:03:00Z", seq: 1 });
		expect(hooks.setDateTime).toHaveBeenCalledTimes(1);
		expect((hooks.setDateTime.mock.calls[0][0] as Date).toISOString()).toBe(
			"2001-09-11T13:03:00.000Z",
		);
	});

	// Forced clock mode is the streamer driving every client; a teacher's jump
	// must not fight it, exactly as the playlist engine's jumps don't.
	it("suppresses a jump while the clock is locked by forced mode", () => {
		mount({ action: "jump", time: "2001-09-11T13:03:00Z", seq: 1 }, true);
		expect(hooks.setDateTime).not.toHaveBeenCalled();
	});

	it("ignores a jump with an out-of-range or unparseable time", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		mount({ action: "jump", time: "not-a-date", seq: 1 });
		expect(hooks.setDateTime).not.toHaveBeenCalled();
	});

	it("opens the focused app", () => {
		mount({ action: "focus", app: "TV.app", seq: 1 });
		expect(hooks.dispatch).toHaveBeenCalledTimes(1);
		const action = hooks.dispatch.mock.calls[0][0] as { type: string; app: { id: string } };
		expect(action.type).toBe("ClassicyAppOpen");
		expect(action.app.id).toBe("TV.app");
	});

	it("shows a teacher message", () => {
		mount({ action: "message", message: "Look at channel 4", seq: 1 });
		expect(screen.getByText("Look at channel 4")).toBeTruthy();
	});

	// A teacher may deliberately repeat a command. seq is what distinguishes a
	// genuine repeat from a re-render, so the same payload must fire twice.
	it("re-applies an identical command when seq advances", () => {
		const rerender = mount({ action: "focus", app: "TV.app", seq: 1 });
		expect(hooks.dispatch).toHaveBeenCalledTimes(1);
		rerender({ action: "focus", app: "TV.app", seq: 2 });
		expect(hooks.dispatch).toHaveBeenCalledTimes(2);
	});

	it("does not re-apply on a re-render with the same seq", () => {
		const rerender = mount({ action: "focus", app: "TV.app", seq: 1 });
		rerender({ action: "focus", app: "TV.app", seq: 1 });
		expect(hooks.dispatch).toHaveBeenCalledTimes(1);
	});

	it("does nothing when no command has arrived", () => {
		mount(null);
		expect(hooks.setDateTime).not.toHaveBeenCalled();
		expect(hooks.dispatch).not.toHaveBeenCalled();
	});
});
