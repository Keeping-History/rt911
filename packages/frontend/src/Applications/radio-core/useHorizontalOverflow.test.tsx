import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHorizontalOverflow } from "./useHorizontalOverflow";

afterEach(cleanup);

// jsdom has no ResizeObserver and no layout, so the stub records the measure
// callback for manual triggering and tests set scrollWidth/clientWidth
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

function Probe() {
	const { containerRef, contentRef, overflowing } = useHorizontalOverflow();
	return (
		<div ref={containerRef} data-testid="container">
			<ul ref={contentRef} data-testid="content" />
			<span data-testid="state">{String(overflowing)}</span>
		</div>
	);
}

function setWidths(container: HTMLElement, content: HTMLElement, widths: { container: number; content: number }) {
	Object.defineProperty(container, "clientWidth", { configurable: true, value: widths.container });
	Object.defineProperty(content, "scrollWidth", { configurable: true, value: widths.content });
}

function remeasure() {
	const observer = ResizeObserverStub.instances.at(-1);
	if (!observer) throw new Error("hook never constructed a ResizeObserver");
	act(() => observer.callback([], observer as unknown as ResizeObserver));
}

describe("useHorizontalOverflow", () => {
	beforeEach(() => {
		ResizeObserverStub.instances = [];
		vi.stubGlobal("ResizeObserver", ResizeObserverStub);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("observes both the container and the content", () => {
		const { getByTestId } = render(<Probe />);
		const observer = ResizeObserverStub.instances.at(-1);
		expect(observer?.observed).toContain(getByTestId("container"));
		expect(observer?.observed).toContain(getByTestId("content"));
	});

	it("reports no overflow while the content fits the container", () => {
		const { getByTestId } = render(<Probe />);
		setWidths(getByTestId("container"), getByTestId("content"), { container: 200, content: 100 });
		remeasure();
		expect(getByTestId("state").textContent).toBe("false");
	});

	it("reports overflow when the content is wider than the container", () => {
		const { getByTestId } = render(<Probe />);
		setWidths(getByTestId("container"), getByTestId("content"), { container: 200, content: 300 });
		remeasure();
		expect(getByTestId("state").textContent).toBe("true");
	});

	it("flips back to fitting when the content shrinks (segment swap)", () => {
		const { getByTestId } = render(<Probe />);
		setWidths(getByTestId("container"), getByTestId("content"), { container: 200, content: 300 });
		remeasure();
		expect(getByTestId("state").textContent).toBe("true");
		setWidths(getByTestId("container"), getByTestId("content"), { container: 200, content: 150 });
		remeasure();
		expect(getByTestId("state").textContent).toBe("false");
	});

	it("ignores 1px of subpixel-rounding slack", () => {
		const { getByTestId } = render(<Probe />);
		setWidths(getByTestId("container"), getByTestId("content"), { container: 200, content: 201 });
		remeasure();
		expect(getByTestId("state").textContent).toBe("false");
	});

	it("stays inert (no crash, no overflow) when ResizeObserver is unavailable", () => {
		vi.unstubAllGlobals();
		const { getByTestId } = render(<Probe />);
		expect(getByTestId("state").textContent).toBe("false");
	});
});
