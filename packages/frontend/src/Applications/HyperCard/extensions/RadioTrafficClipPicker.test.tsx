import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClassicyFileDialogVolume, ClassicyFileOpenSelection } from "classicy";
import { RadioTrafficClipPicker } from "./RadioTrafficClipPicker";

const fileOpenDialog = vi.hoisted(() => ({
	current: null as null | {
		open?: boolean;
		volumes?: ClassicyFileDialogVolume[];
		onOpenFunc?: (selections: ClassicyFileOpenSelection[]) => void;
		onCancelFunc?: () => void;
	},
}));
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyFileOpenDialog: (props: {
		open?: boolean;
		volumes?: ClassicyFileDialogVolume[];
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
		expect(screen.getByDisplayValue("42")).toBeTruthy();
		expect(screen.getByRole("button", { name: /browse/i })).toBeTruthy();
	});

	it("shows the (none) placeholder, not the literal text, for a null value", () => {
		render(<RadioTrafficClipPicker value={null} onChange={vi.fn()} />);
		const input = screen.getByRole("textbox") as HTMLInputElement;
		expect(input.value).toBe("");
		expect(input.placeholder).toBe("(none)");
		expect(screen.queryByText("null")).toBeNull();
	});

	it("renders a Clip label ahead of the value/Browse row", () => {
		render(<RadioTrafficClipPicker value={""} onChange={vi.fn()} />);
		expect(screen.getByText("Clip")).toBeTruthy();
	});

	it("commits a directly-typed value (e.g. a bound script variable name) on blur", () => {
		const onChange = vi.fn();
		render(<RadioTrafficClipPicker value={""} onChange={onChange} />);
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "currentClip" } });
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.blur(input);
		expect(onChange).toHaveBeenCalledWith("currentClip");
	});

	it("does not commit on blur when the typed value didn't change", () => {
		const onChange = vi.fn();
		render(<RadioTrafficClipPicker value={"42"} onChange={onChange} />);
		const input = screen.getByRole("textbox");
		fireEvent.blur(input);
		expect(onChange).not.toHaveBeenCalled();
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

// Both call sites of radio-core/radioTrafficVolume are otherwise tested against
// a MOCKED module — nothing runs a REAL buildRadioTrafficVolume() entry into a
// real consumer's selection-handling code. This is the integration seam that
// let Finding 1 (a number where selectionsToEntries required a string) through
// clean per-task reviews. Unmock just for this test: only fetch/directusGet is
// faked (same fixture-row shape radioTrafficVolume.test.ts uses), so the real
// module runs and produces a real entry, which is fed through the still-mocked
// ClassicyFileOpenDialog's onOpenFunc callback path (proving the entry SHAPE,
// not re-testing classicy's own dialog chrome) into the real component's real
// onChange handler.
describe("RadioTrafficClipPicker integration (real buildRadioTrafficVolume)", () => {
	it("flows a real module entry through the real onOpenFunc handler into onChange", async () => {
		vi.doUnmock("../../radio-core/radioTrafficVolume");
		vi.resetModules();
		try {
			const { RadioTrafficClipPicker: RealPicker } = await import("./RadioTrafficClipPicker");
			const { buildRadioTrafficVolume: realBuildRadioTrafficVolume } = await import(
				"../../radio-core/radioTrafficVolume"
			);

			const rows = [
				{
					id: 501, title: "AAL11 loses contact", full_title: "American 11 loses contact with ATC",
					source: { slug: "zbw" }, tags: [
						{ mp3_tags_id: { tag: "topic:loss-of-contact", namespace: "topic", value: "loss-of-contact" } },
					],
				},
			];
			const fetchFn = vi.fn(async (url: string) => {
				if (!url.includes("/items/mp3_items")) throw new Error(`unexpected url ${url}`);
				return new Response(JSON.stringify({ data: rows }));
			});

			const realVolume = realBuildRadioTrafficVolume(fetchFn as unknown as typeof fetch);
			const realClips = await realVolume.list(["Topic", "loss-of-contact"]);
			expect(realClips).toHaveLength(1);
			// Directus returns a numeric id — the exact shape that broke
			// PlaylistEditor's string-only selectionsToEntries in Finding 1.
			expect(typeof realClips[0].meta?.itemId).toBe("number");
			expect(realClips[0].meta?.itemId).toBe(501);

			const onChange = vi.fn();
			render(<RealPicker value="" onChange={onChange} />);
			fireEvent.click(screen.getByRole("button", { name: /browse/i }));

			act(() => {
				fileOpenDialog.current?.onOpenFunc?.([
					{ volumeId: realVolume.id, path: ["Topic", "loss-of-contact"], entry: realClips[0] },
				]);
			});

			expect(onChange).toHaveBeenCalledWith(String(realClips[0].meta?.itemId));
			expect(onChange).toHaveBeenCalledWith("501");
		} finally {
			vi.doMock("../../radio-core/radioTrafficVolume", () => ({
				buildRadioTrafficVolume: () => ({ id: "radio-traffic-tags", label: "Radio Traffic", list: async () => [] }),
			}));
			vi.resetModules();
		}
	});
});
