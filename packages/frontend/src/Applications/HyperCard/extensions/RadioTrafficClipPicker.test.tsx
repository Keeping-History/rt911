import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClassicyFileOpenSelection } from "classicy";
import { RadioTrafficClipPicker } from "./RadioTrafficClipPicker";

const fileOpenDialog = vi.hoisted(() => ({
	current: null as null | {
		open?: boolean;
		onOpenFunc?: (selections: ClassicyFileOpenSelection[]) => void;
		onCancelFunc?: () => void;
	},
}));
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyFileOpenDialog: (props: {
		open?: boolean;
		onOpenFunc?: (selections: ClassicyFileOpenSelection[]) => void;
		onCancelFunc?: () => void;
	}) => {
		fileOpenDialog.current = props;
		return null;
	},
}));
vi.mock("../../radio-core/radioTrafficVolume", () => ({
	buildRadioTrafficVolume: () => ({ id: "radio-traffic-tags", label: "Radio Traffic", list: async () => [] }),
}));

afterEach(cleanup);

describe("RadioTrafficClipPicker", () => {
	it("shows the current value and a Browse control", () => {
		render(<RadioTrafficClipPicker value={"42"} onChange={vi.fn()} />);
		expect(screen.getByText(/42/)).toBeTruthy();
		expect(screen.getByRole("button", { name: /browse/i })).toBeTruthy();
	});

	it("opens the dialog on Browse, and commits the selected clip's id", () => {
		const onChange = vi.fn();
		render(<RadioTrafficClipPicker value={""} onChange={onChange} />);
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		expect(fileOpenDialog.current?.open).toBe(true);

		act(() => {
			fileOpenDialog.current?.onOpenFunc?.([
				{
					volumeId: "radio-traffic-tags",
					path: ["Topic", "loss-of-contact"],
					entry: {
						id: "radio-traffic-501", name: "American 11 loses contact",
						kind: "file", fileType: "radio-traffic", meta: { app: "radio", itemId: 501 },
					},
				},
			]);
		});
		expect(onChange).toHaveBeenCalledWith("501");
		expect(fileOpenDialog.current?.open).toBe(false);
	});

	it("closes without committing on cancel", () => {
		const onChange = vi.fn();
		render(<RadioTrafficClipPicker value={""} onChange={onChange} />);
		fireEvent.click(screen.getByRole("button", { name: /browse/i }));
		act(() => {
			fileOpenDialog.current?.onCancelFunc?.();
		});
		expect(onChange).not.toHaveBeenCalled();
		expect(fileOpenDialog.current?.open).toBe(false);
	});
});
