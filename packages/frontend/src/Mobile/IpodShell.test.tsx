// packages/frontend/src/Mobile/IpodShell.test.tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useContext } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaStreamContext } from "../Providers/MediaStream/MediaStreamContext";
import IpodShell from "./IpodShell";

vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<object>()),
	// localDate is the DISPLAY value classicy's ticking clock returns (UTC
	// shifted by tzOffset -4) — useFineClock strips the offset back off via
	// virtualUtcMs to recover the true UTC instant (12:40 UTC here).
	useClassicyDateTime: () => ({
		dateTime: "2001-09-11T12:40:00.000Z",
		localDate: new Date("2001-09-11T08:40:00.000Z"),
		paused: false,
		tzOffset: -4,
		setDateTime: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
	}),
}));

afterEach(cleanup);
window.HTMLElement.prototype.scrollIntoView = vi.fn();

// The context's default value (not exported) already provides no-op
// subscribe functions and empty data with connected: false. Reading it via
// useContext outside any provider and re-providing with connected flipped
// gives a full, valid context value without restating all ~40 fields.
function WithConnected({ children }: { children: React.ReactNode }) {
	const base = useContext(MediaStreamContext);
	return (
		<MediaStreamContext.Provider value={{ ...base, connected: true }}>
			{children}
		</MediaStreamContext.Provider>
	);
}

const renderShell = (connected: boolean) =>
	connected
		? render(
				<WithConnected>
					<IpodShell />
				</WithConnected>,
			)
		: render(<IpodShell />); // default context value has connected: false

describe("IpodShell", () => {
	it("shows the main menu with the virtual-clock status bar when connected", () => {
		renderShell(true);
		expect(screen.getByText("iPod")).toBeTruthy(); // status-bar title
		expect(screen.getByText("Radio")).toBeTruthy();
		expect(screen.getByText("Time Travel")).toBeTruthy();
		expect(screen.getByText("About")).toBeTruthy();
		expect(screen.getByText("8:40 AM")).toBeTruthy(); // 12:40 UTC at -4
	});

	it("shows Connecting… when the stream is down", () => {
		renderShell(false);
		expect(screen.getByText("Connecting…")).toBeTruthy();
	});

	it("navigates to About on tap and back via MENU", () => {
		const { container } = renderShell(true);
		fireEvent.click(screen.getByText("About"));
		expect(screen.getByText(/adapted from mitchivin/)).toBeTruthy();
		const wheelEl = container.querySelector("#control-wheel") as HTMLElement;
		const menuBtn = container.querySelector("#menu-btn") as HTMLElement;
		fireEvent.pointerDown(menuBtn, { pointerId: 1, clientX: 0, clientY: 0 });
		fireEvent.pointerUp(wheelEl, { pointerId: 1, clientX: 0, clientY: 0 });
		expect(screen.getByText("Radio")).toBeTruthy(); // back on the menu
	});
});
