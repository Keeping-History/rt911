import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeEvent, ReactNode } from "react";

vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyWindow: ({ children, id, title }: { children?: ReactNode; id?: string; title?: string }) => (
		<div data-testid={`win-${id}`} data-title={title}>
			{children}
		</div>
	),
	ClassicyPopUpMenu: ({
		id,
		label,
		options,
		selected,
		onChangeFunc,
	}: {
		id: string;
		label?: string;
		options: Array<{ value: string; label: string }>;
		selected?: string;
		onChangeFunc?: (e: ChangeEvent<HTMLSelectElement>) => void;
	}) => (
		<label>
			{label}
			<select id={id} value={selected} onChange={(e) => onChangeFunc?.(e)}>
				{options.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
		</label>
	),
}));

const listRows = [
	{ id: 1, title: "WNYW", full_title: "WNYW Fox 5", source: "fox" },
	{ id: 2, title: "WCBS", full_title: "WCBS CBS 2", source: "cbs" },
];
const fetchDirectusVideoList = vi.hoisted(() => vi.fn());
vi.mock("./directusCollections", () => ({ fetchDirectusVideoList }));

import { TVMultiviewPicker } from "./TVMultiviewPicker";

afterEach(() => {
	cleanup();
	fetchDirectusVideoList.mockReset();
});

describe("TVMultiviewPicker", () => {
	it("reads the pending selection from the videos array's channelId fields", async () => {
		fetchDirectusVideoList.mockResolvedValue(listRows);
		render(
			<TVMultiviewPicker
				value={[{ channelId: "1", start: 10 }]}
				onChange={vi.fn()}
			/>,
		);
		expect(screen.getByText("1 selected")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		await screen.findByLabelText("WNYW Fox 5");
		expect((screen.getByLabelText("WNYW Fox 5") as HTMLInputElement).checked).toBe(true);
	});

	it("preserves a kept channel's other settings and adds a bare object for a new one", async () => {
		fetchDirectusVideoList.mockResolvedValue(listRows);
		const onChange = vi.fn();
		render(
			<TVMultiviewPicker
				value={[{ channelId: "1", start: 10, autoPlay: true }]}
				onChange={onChange}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		await screen.findByLabelText("WNYW Fox 5");
		// Channel 1 stays checked (seeded from `value`); also check channel 2.
		fireEvent.click(screen.getByLabelText("WCBS CBS 2"));
		fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

		expect(onChange).toHaveBeenCalledTimes(1);
		const result = onChange.mock.calls[0][0] as Array<Record<string, unknown>>;
		expect(result).toHaveLength(2);
		expect(result.find((v) => v.channelId === "1")).toEqual({ channelId: "1", start: 10, autoPlay: true });
		expect(result.find((v) => v.channelId === "2")).toEqual({ channelId: "2" });
	});

	it("drops a channel that's unchecked, discarding its settings", async () => {
		fetchDirectusVideoList.mockResolvedValue(listRows);
		const onChange = vi.fn();
		render(
			<TVMultiviewPicker
				value={[
					{ channelId: "1", start: 10 },
					{ channelId: "2" },
				]}
				onChange={onChange}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		await screen.findByLabelText("WNYW Fox 5");
		fireEvent.click(screen.getByLabelText("WNYW Fox 5")); // uncheck channel 1
		fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

		expect(onChange).toHaveBeenCalledWith([{ channelId: "2" }]);
	});
});
