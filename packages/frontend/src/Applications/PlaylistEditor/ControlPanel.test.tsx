import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomCommandError } from "../../Providers/Playlist/roomApi";
import { CONTROL_NO_PLAYLIST, ControlPanel } from "./ControlPanel";

afterEach(cleanup);

const clockButton = () => screen.getByRole("button", { name: "Clock" });
const contentButton = () => screen.getByRole("button", { name: "Content" });

// ClassicyButton derives aria-pressed from its `depressed` prop and omits the
// attribute entirely when not pressed, so absence — not "false" — is the
// unpressed state.
const clockPressed = () => clockButton().getAttribute("aria-pressed") === "true";

describe("ControlPanel", () => {
	it("locks the clock for the open playlist", async () => {
		const sendLock = vi.fn().mockResolvedValue(undefined);
		render(<ControlPanel playlistId="p1" playlistTitle="Lesson" sendLock={sendLock} />);

		fireEvent.click(clockButton());

		await waitFor(() => expect(sendLock).toHaveBeenCalledWith("p1", "clock", true));
		await waitFor(() => expect(clockPressed()).toBe(true));
	});

	it("unlocks on a second click — the button is a toggle", async () => {
		const sendLock = vi.fn().mockResolvedValue(undefined);
		render(<ControlPanel playlistId="p1" sendLock={sendLock} />);

		fireEvent.click(clockButton());
		await waitFor(() => expect(clockPressed()).toBe(true));
		fireEvent.click(clockButton());

		await waitFor(() => expect(sendLock).toHaveBeenLastCalledWith("p1", "clock", false));
		await waitFor(() => expect(clockPressed()).toBe(false));
	});

	// The button must never claim a lock that no student received.
	it("stays unlocked and explains why when the command is refused", async () => {
		const sendLock = vi
			.fn()
			.mockRejectedValue(new RoomCommandError("Only the person who created this playlist can control it."));
		render(<ControlPanel playlistId="p1" sendLock={sendLock} />);

		fireEvent.click(clockButton());

		await waitFor(() =>
			expect(
				screen.getByText("Only the person who created this playlist can control it."),
			).toBeTruthy(),
		);
		expect(clockPressed()).toBe(false);
	});

	it("disables Content — it is not wired to anything yet", () => {
		render(<ControlPanel playlistId="p1" sendLock={vi.fn()} />);
		expect((contentButton() as HTMLButtonElement).disabled).toBe(true);
	});

	it("sends nothing for Content", () => {
		const sendLock = vi.fn();
		render(<ControlPanel playlistId="p1" sendLock={sendLock} />);
		fireEvent.click(contentButton());
		expect(sendLock).not.toHaveBeenCalled();
	});

	it("has nothing to control with no playlist open", () => {
		const sendLock = vi.fn();
		render(<ControlPanel playlistId={null} sendLock={sendLock} />);

		expect(screen.getByText(CONTROL_NO_PLAYLIST)).toBeTruthy();
		expect((clockButton() as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(clockButton());
		expect(sendLock).not.toHaveBeenCalled();
	});

	it("groups the toggles under a Lock legend", () => {
		render(<ControlPanel playlistId="p1" sendLock={vi.fn()} />);
		expect(screen.getByText("Lock")).toBeTruthy();
	});

	// A double-click while the first command is still in flight would otherwise
	// send lock and lock again, leaving the button out of step with the room.
	it("ignores a click while a command is in flight", async () => {
		let release: () => void = () => {};
		const sendLock = vi.fn().mockReturnValue(new Promise<void>((r) => { release = r; }));
		render(<ControlPanel playlistId="p1" sendLock={sendLock} />);

		fireEvent.click(clockButton());
		fireEvent.click(clockButton());
		expect(sendLock).toHaveBeenCalledTimes(1);

		release();
		await waitFor(() => expect(clockPressed()).toBe(true));
	});
});
