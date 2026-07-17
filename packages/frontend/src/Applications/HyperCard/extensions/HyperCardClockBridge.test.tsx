import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Capture the registered effect handler and control the mocked clock hooks.
const hooks = vi.hoisted(() => ({
	setDateTime: undefined as unknown as ReturnType<typeof vi.fn>,
	locked: false,
	handler: undefined as unknown as (args: Record<string, unknown>, api: unknown) => void,
}));

vi.mock("classicy", () => ({
	useClassicyDateTime: () => ({ setDateTime: hooks.setDateTime }),
	useAppManager: (sel: (s: unknown) => unknown) =>
		sel({ System: { Manager: { DateAndTime: { dateTimeLocked: hooks.locked } } } }),
	registerHyperCardEffectHandler: (_name: string, h: typeof hooks.handler) => {
		hooks.handler = h;
	},
}));

import { HyperCardClockBridge } from "./HyperCardClockBridge";
import { CLOCK_RANGE_END_ISO } from "./dateRange";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function mount(locked = false) {
	hooks.setDateTime = vi.fn();
	hooks.locked = locked;
	hooks.handler = undefined as never;
	render(<HyperCardClockBridge />);
	expect(hooks.handler).toBeTruthy();
}

const appliedIso = () => (hooks.setDateTime.mock.calls[0][0] as Date).toISOString();

describe("HyperCardClockBridge", () => {
	it("applies an in-range instant through the clock seam", () => {
		mount();
		act(() => hooks.handler({ to: "2001-09-11T12:46:00" }, {}));
		expect(hooks.setDateTime).toHaveBeenCalledTimes(1);
		expect(appliedIso()).toBe("2001-09-11T12:46:00.000Z");
	});

	it("clamps an out-of-range instant into the window", () => {
		mount();
		act(() => hooks.handler({ to: "2001-09-20T00:00:00" }, {}));
		expect(appliedIso()).toBe(new Date(CLOCK_RANGE_END_ISO).toISOString());
	});

	it("does nothing while the clock is locked (forced-clock mode)", () => {
		mount(true);
		act(() => hooks.handler({ to: "2001-09-11T12:46:00" }, {}));
		expect(hooks.setDateTime).not.toHaveBeenCalled();
	});

	it("ignores an unparseable date", () => {
		mount();
		act(() => hooks.handler({ to: "not a date" }, {}));
		expect(hooks.setDateTime).not.toHaveBeenCalled();
	});

	it("ignores a missing `to`", () => {
		mount();
		act(() => hooks.handler({}, {}));
		expect(hooks.setDateTime).not.toHaveBeenCalled();
	});
});
