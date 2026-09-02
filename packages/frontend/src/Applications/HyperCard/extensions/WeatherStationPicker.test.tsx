import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
	MediaStreamContext,
	type MediaStreamContextValue,
} from "../../../Providers/MediaStream/MediaStreamContext";

vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyWindow: ({ children, id, title }: { children?: ReactNode; id?: string; title?: string }) => (
		<div data-testid={`win-${id}`} data-title={title}>
			{children}
		</div>
	),
}));

import { WeatherStationPicker } from "./WeatherStationPicker";

afterEach(cleanup);

function renderPicker(observations: Record<string, unknown>, onChange = vi.fn()) {
	const ctx = {
		weatherObservations: observations,
		subscribeWeather: vi.fn(),
		unsubscribeWeather: vi.fn(),
	} as unknown as MediaStreamContextValue;
	render(
		<MediaStreamContext.Provider value={ctx}>
			<WeatherStationPicker value={[]} onChange={onChange} />
		</MediaStreamContext.Provider>,
	);
	return ctx;
}

describe("WeatherStationPicker", () => {
	it("subscribes to the weather channel on mount", () => {
		const ctx = renderPicker({});
		expect(ctx.subscribeWeather).toHaveBeenCalledTimes(1);
	});

	it("lists only stations currently reporting a live observation", async () => {
		renderPicker({ KJFK: {}, KBOS: {}, ZZZZ: {} });
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		expect(await screen.findByLabelText(/KJFK/)).toBeTruthy();
		expect(screen.getByLabelText(/KBOS/)).toBeTruthy();
		// ZZZZ isn't a real station in stations.json, so it's dropped even
		// though it has a live observation.
		expect(screen.queryByLabelText(/ZZZZ/)).toBeNull();
	});

	it("shows an empty-state message when nothing is currently reporting", async () => {
		renderPicker({});
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		expect(await screen.findByText("No stations are currently reporting.")).toBeTruthy();
	});

	it("confirms the selected station ids", async () => {
		const onChange = vi.fn();
		renderPicker({ KJFK: {}, KBOS: {} }, onChange);
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		fireEvent.click(await screen.findByLabelText(/KJFK/));
		fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
		expect(onChange).toHaveBeenCalledWith(["KJFK"]);
	});

	it("does not call onChange on Cancel", async () => {
		const onChange = vi.fn();
		renderPicker({ KJFK: {} }, onChange);
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		await screen.findByLabelText(/KJFK/);
		act(() => {
			fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
		});
		expect(onChange).not.toHaveBeenCalled();
	});
});
