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

const fetchDirectusPagerList = vi.hoisted(() => vi.fn());
const fetchDirectusPagerProviders = vi.hoisted(() => vi.fn());
vi.mock("./directusCollections", () => ({ fetchDirectusPagerList, fetchDirectusPagerProviders }));

import { PagerMessagePicker } from "./PagerMessagePicker";

afterEach(() => {
	cleanup();
	fetchDirectusPagerList.mockReset();
	fetchDirectusPagerProviders.mockReset();
});

describe("PagerMessagePicker", () => {
	it("lists rows with a provider prefix", async () => {
		fetchDirectusPagerProviders.mockResolvedValue(["SkyTel"]);
		fetchDirectusPagerList.mockResolvedValue([{ id: 5, message: "CALL OPS CENTER", provider: "SkyTel" }]);
		render(<PagerMessagePicker value={[]} onChange={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		expect(await screen.findByLabelText("SkyTel — CALL OPS CENTER")).toBeTruthy();
		expect(fetchDirectusPagerList).toHaveBeenCalledWith(
			{ provider: undefined, recipient: undefined, message: undefined },
		);
	});

	it("passes the search box text through as a server-side message filter", async () => {
		fetchDirectusPagerProviders.mockResolvedValue([]);
		fetchDirectusPagerList.mockResolvedValue([]);
		render(<PagerMessagePicker value={[]} onChange={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		await screen.findByText("No pager messages match.");
		fireEvent.change(screen.getByLabelText("Search"), { target: { value: "OPS" } });
		await vi.waitFor(() =>
			expect(fetchDirectusPagerList).toHaveBeenLastCalledWith({
				provider: undefined,
				recipient: undefined,
				message: "OPS",
			}),
		);
	});

	it("filters by provider via the pop-up", async () => {
		fetchDirectusPagerProviders.mockResolvedValue(["SkyTel", "PageNet"]);
		fetchDirectusPagerList.mockResolvedValue([]);
		render(<PagerMessagePicker value={[]} onChange={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		await screen.findByLabelText("Provider");
		fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "PageNet" } });
		await vi.waitFor(() =>
			expect(fetchDirectusPagerList).toHaveBeenLastCalledWith({
				provider: "PageNet",
				recipient: undefined,
				message: undefined,
			}),
		);
	});

	it("confirms the selected ids", async () => {
		fetchDirectusPagerProviders.mockResolvedValue([]);
		fetchDirectusPagerList.mockResolvedValue([{ id: 5, message: "PAGE", provider: null }]);
		const onChange = vi.fn();
		render(<PagerMessagePicker value={[]} onChange={onChange} />);
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		fireEvent.click(await screen.findByLabelText("PAGE"));
		fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
		expect(onChange).toHaveBeenCalledWith(["5"]);
	});
});
