import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVerticalStackOverflow } from "./useVerticalStackOverflow";

afterEach(cleanup);

// jsdom has no ResizeObserver and no layout, so the stub records the measure
// callback for manual triggering and tests set offsetHeight/clientHeight
// directly on the nodes (both are 0 by default in jsdom).
class ResizeObserverStub {
	static instances: ResizeObserverStub[] = [];
	observed: Element[] = [];
	callback: ResizeObserverCallback;
	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		ResizeObserverStub.instances.push(this);
	}
	observe(el: Element) {
		this.observed.push(el);
	}
	unobserve() {}
	disconnect() {}
}

function Probe({ withExtra = true }: { withExtra?: boolean }) {
	const { containerRef, labelRef, extraRef, overflowing } = useVerticalStackOverflow();
	return (
		<div ref={containerRef} data-testid="container">
			<p ref={labelRef} data-testid="label" />
			{withExtra && <div ref={extraRef} data-testid="extra" />}
			<span data-testid="state">{String(overflowing)}</span>
		</div>
	);
}

function setHeights(
	nodes: { container: HTMLElement; label: HTMLElement; extra?: HTMLElement },
	heights: { container: number; label: number; extra?: number },
) {
	Object.defineProperty(nodes.container, "clientHeight", { configurable: true, value: heights.container });
	Object.defineProperty(nodes.label, "offsetHeight", { configurable: true, value: heights.label });
	if (nodes.extra && heights.extra !== undefined) {
		Object.defineProperty(nodes.extra, "offsetHeight", { configurable: true, value: heights.extra });
	}
}

function remeasure() {
	const observer = ResizeObserverStub.instances.at(-1);
	if (!observer) throw new Error("hook never constructed a ResizeObserver");
	act(() => observer.callback([], observer as unknown as ResizeObserver));
}

describe("useVerticalStackOverflow", () => {
	beforeEach(() => {
		ResizeObserverStub.instances = [];
		vi.stubGlobal("ResizeObserver", ResizeObserverStub);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("observes the container and both children", () => {
		const { getByTestId } = render(<Probe />);
		const observer = ResizeObserverStub.instances.at(-1);
		expect(observer?.observed).toContain(getByTestId("container"));
		expect(observer?.observed).toContain(getByTestId("label"));
		expect(observer?.observed).toContain(getByTestId("extra"));
	});

	it("reports no overflow while the stacked pair fits the container", () => {
		const { getByTestId } = render(<Probe />);
		setHeights(
			{ container: getByTestId("container"), label: getByTestId("label"), extra: getByTestId("extra") },
			{ container: 40, label: 12, extra: 10 },
		);
		remeasure();
		expect(getByTestId("state").textContent).toBe("false");
	});

	it("reports overflow when the stacked pair is taller than the container", () => {
		const { getByTestId } = render(<Probe />);
		setHeights(
			{ container: getByTestId("container"), label: getByTestId("label"), extra: getByTestId("extra") },
			{ container: 20, label: 12, extra: 10 },
		);
		remeasure();
		expect(getByTestId("state").textContent).toBe("true");
	});

	it("flips back to fitting when the container grows (window resize)", () => {
		const { getByTestId } = render(<Probe />);
		const nodes = { container: getByTestId("container"), label: getByTestId("label"), extra: getByTestId("extra") };
		setHeights(nodes, { container: 20, label: 12, extra: 10 });
		remeasure();
		expect(getByTestId("state").textContent).toBe("true");
		setHeights(nodes, { container: 40, label: 12, extra: 10 });
		remeasure();
		expect(getByTestId("state").textContent).toBe("false");
	});

	it("ignores 1px of subpixel-rounding slack", () => {
		const { getByTestId } = render(<Probe />);
		setHeights(
			{ container: getByTestId("container"), label: getByTestId("label"), extra: getByTestId("extra") },
			{ container: 22, label: 12, extra: 11 },
		);
		remeasure();
		expect(getByTestId("state").textContent).toBe("false");
	});

	it("reports fitting when the extra element never mounts (online station)", () => {
		const { getByTestId } = render(<Probe withExtra={false} />);
		expect(getByTestId("state").textContent).toBe("false");
	});

	it("clears a stale overflow when the extra element unmounts", () => {
		const { getByTestId, rerender } = render(<Probe />);
		setHeights(
			{ container: getByTestId("container"), label: getByTestId("label"), extra: getByTestId("extra") },
			{ container: 20, label: 12, extra: 10 },
		);
		remeasure();
		expect(getByTestId("state").textContent).toBe("true");
		rerender(<Probe withExtra={false} />);
		expect(getByTestId("state").textContent).toBe("false");
	});

	it("stays inert (no crash, no overflow) when ResizeObserver is unavailable", () => {
		vi.unstubAllGlobals();
		const { getByTestId } = render(<Probe />);
		expect(getByTestId("state").textContent).toBe("false");
	});
});
