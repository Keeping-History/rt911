import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyWindow: ({ children, id, title }: { children?: ReactNode; id?: string; title?: string }) => (
		<div data-testid={`win-${id}`} data-title={title}>
			{children}
		</div>
	),
}));

const listRows = [
	{ id: 9, title: "Short", full_title: "A Fuller Headline", start_date: "2001-09-11T12:46:00" },
	{ id: 10, title: "Ten", full_title: null, start_date: "2001-09-11T13:00:00" },
];
const fetchDirectusNewsList = vi.hoisted(() => vi.fn());
vi.mock("./directusCollections", () => ({ fetchDirectusNewsList }));

import { NewsItemPicker } from "./NewsItemPicker";

afterEach(() => {
	cleanup();
	fetchDirectusNewsList.mockReset();
});

describe("NewsItemPicker", () => {
	it("shows '(none)' with no value", () => {
		fetchDirectusNewsList.mockResolvedValue(listRows);
		render(<NewsItemPicker value={undefined} onChange={vi.fn()} />);
		expect(screen.getByText("(none)")).toBeTruthy();
	});

	it("lists every article, falling back to the bare title when full_title is unset", async () => {
		fetchDirectusNewsList.mockResolvedValue(listRows);
		render(<NewsItemPicker value={[]} onChange={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		expect(await screen.findByLabelText("A Fuller Headline")).toBeTruthy();
		expect(screen.getByLabelText("Ten")).toBeTruthy();
	});

	it("narrows the list via the search box", async () => {
		fetchDirectusNewsList.mockResolvedValue(listRows);
		render(<NewsItemPicker value={[]} onChange={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		await screen.findByLabelText("A Fuller Headline");
		fireEvent.change(screen.getByLabelText("Search"), { target: { value: "Ten" } });
		await screen.findByLabelText("Ten");
		expect(screen.queryByLabelText("A Fuller Headline")).toBeNull();
	});

	it("confirms the selected ids", async () => {
		fetchDirectusNewsList.mockResolvedValue(listRows);
		const onChange = vi.fn();
		render(<NewsItemPicker value={[]} onChange={onChange} />);
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		fireEvent.click(await screen.findByLabelText("A Fuller Headline"));
		fireEvent.click(screen.getByLabelText("Ten"));
		fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
		expect((onChange.mock.calls[0][0] as string[]).sort()).toEqual(["10", "9"]);
	});

	it("does not call onChange on Cancel", async () => {
		fetchDirectusNewsList.mockResolvedValue(listRows);
		const onChange = vi.fn();
		render(<NewsItemPicker value={[]} onChange={onChange} />);
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		await screen.findByLabelText("A Fuller Headline");
		act(() => {
			fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
		});
		expect(onChange).not.toHaveBeenCalled();
	});
});
