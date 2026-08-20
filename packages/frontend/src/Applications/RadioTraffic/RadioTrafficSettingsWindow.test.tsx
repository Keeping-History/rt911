import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// rt911 has no global test setup, so testing-library does not auto-clean the
// DOM between tests; do it explicitly to keep document-level queries isolated.
afterEach(cleanup);

// The window is chrome around a handful of classicy controls, so the controls
// are the seams and the chrome is not: stand-ins render the props it passes,
// which is exactly what this suite is about. Nothing here is asserted THROUGH a
// double — the draft behaviour under test is the window's own.
vi.mock("classicy", () => ({
	ClassicyWindow: ({
		children,
		title,
		onCloseFunc,
	}: {
		children?: React.ReactNode;
		title?: string;
		onCloseFunc?: () => void;
	}) => (
		<div data-window-title={title}>
			<button type="button" aria-label="Close" onClick={onCloseFunc} />
			{children}
		</div>
	),
	ClassicyControlGroup: ({
		label,
		children,
	}: {
		label?: string;
		children?: React.ReactNode;
	}) => (
		<fieldset>
			<legend>{label}</legend>
			{children}
		</fieldset>
	),
	ClassicyCheckbox: ({
		id,
		label,
		checked,
		onClickFunc,
	}: {
		id?: string;
		label?: string;
		checked?: boolean;
		onClickFunc?: (checked: boolean) => void;
	}) => (
		<label htmlFor={id}>
			<input
				id={id}
				type="checkbox"
				checked={checked ?? false}
				onChange={() => onClickFunc?.(!checked)}
			/>
			{label}
		</label>
	),
	ClassicyColorPicker: ({
		id,
		labelTitle,
		value,
		onChangeFunc,
	}: {
		id?: string;
		labelTitle?: string;
		value?: number;
		onChangeFunc?: (color: number) => void;
	}) => (
		<button
			type="button"
			id={id}
			aria-label={labelTitle}
			data-color={value}
			onClick={() => onChangeFunc?.(0xff0000)}
		/>
	),
	ClassicyButton: ({
		children,
		onClickFunc,
	}: {
		children?: React.ReactNode;
		onClickFunc?: () => void;
	}) => (
		<button type="button" onClick={onClickFunc}>
			{children}
		</button>
	),
	MAC_OS_8_CRAYONS: [],
	// RadioTrafficContext registers the app at import time, and this suite
	// imports its settings type.
	registerApp: () => {},
}));

import { DEFAULT_RADIO_TRAFFIC_SETTINGS, type RadioTrafficSettings } from "./RadioTrafficContext";
import { RadioTrafficSettingsWindow } from "./RadioTrafficSettingsWindow";

/**
 * The window as the shell drives it: a draft in local state, and a `saved`
 * sink that only Save writes to. That split IS the behaviour under test, so the
 * harness has to model it rather than pass a controlled value straight through.
 */
function Harness({
	initial = DEFAULT_RADIO_TRAFFIC_SETTINGS,
	onSave,
	onCancel = () => {},
}: {
	initial?: RadioTrafficSettings;
	onSave: (settings: RadioTrafficSettings) => void;
	onCancel?: () => void;
}) {
	const [form, setForm] = useState<RadioTrafficSettings>(initial);
	return (
		<RadioTrafficSettingsWindow
			appId="RadioTraffic.app"
			appIcon="icon.png"
			appMenu={[]}
			form={form}
			setForm={setForm}
			onCancel={onCancel}
			onSave={() => onSave(form)}
		/>
	);
}

const themeCheckbox = () => screen.getByLabelText("Use theme colors") as HTMLInputElement;
const picker = () => screen.queryByLabelText("Waveform");
const originalCheckbox = () =>
	screen.getByLabelText("Play original recording (more noise)") as HTMLInputElement;

describe("RadioTrafficSettingsWindow", () => {
	it("opens on the Settings window, following the theme by default", () => {
		render(<Harness onSave={() => {}} />);
		expect(screen.getByText("Waveform Color")).toBeTruthy();
		expect(themeCheckbox().checked).toBe(true);
		// Nothing to pick while the theme is in charge.
		expect(picker()).toBeNull();
	});

	it("reveals the color picker once the theme is switched off", () => {
		render(<Harness onSave={() => {}} />);
		fireEvent.click(themeCheckbox());
		expect(themeCheckbox().checked).toBe(false);
		expect(picker()?.getAttribute("data-color")).toBe(
			String(DEFAULT_RADIO_TRAFFIC_SETTINGS.waveformColor),
		);
	});

	it("hands the chosen color back on Save", () => {
		const onSave = vi.fn();
		render(<Harness onSave={onSave} />);
		fireEvent.click(themeCheckbox());
		fireEvent.click(picker() as HTMLElement);
		fireEvent.click(screen.getByText("Save"));
		expect(onSave).toHaveBeenCalledWith({
			useThemeWaveformColor: false,
			waveformColor: 0xff0000,
			playOriginalAudio: false,
		});
	});

	// The draft is the whole point of seeding `form` on open: a listener who
	// picks a colour, thinks better of it and cancels must be left exactly where
	// they started, with nothing dispatched.
	it("dispatches nothing when the listener cancels", () => {
		const onSave = vi.fn();
		const onCancel = vi.fn();
		render(<Harness onSave={onSave} onCancel={onCancel} />);
		fireEvent.click(themeCheckbox());
		fireEvent.click(picker() as HTMLElement);
		fireEvent.click(screen.getByText("Cancel"));
		expect(onCancel).toHaveBeenCalled();
		expect(onSave).not.toHaveBeenCalled();
	});

	// The close box is Cancel, not a silent Save — a window whose X committed
	// changes would be the one control here that cannot be backed out of.
	it("treats the window's close box as Cancel", () => {
		const onSave = vi.fn();
		const onCancel = vi.fn();
		render(<Harness onSave={onSave} onCancel={onCancel} />);
		fireEvent.click(screen.getByLabelText("Close"));
		expect(onCancel).toHaveBeenCalled();
		expect(onSave).not.toHaveBeenCalled();
	});

	it("opens showing the color a previous session saved", () => {
		render(
			<Harness
				initial={{
					useThemeWaveformColor: false,
					waveformColor: 0x123456,
					playOriginalAudio: false,
				}}
				onSave={() => {}}
			/>,
		);
		expect(themeCheckbox().checked).toBe(false);
		expect(picker()?.getAttribute("data-color")).toBe(String(0x123456));
	});

	// The control this app took over from radio-core's shared window, where it
	// sat in front of the Tuner's broadcast stations. It is about the enhancement
	// pass, which runs over comm traffic — this app's entire subject.
	describe("the original-recording choice", () => {
		it("offers the choice, defaulting to the noise-reduced render", () => {
			render(<Harness onSave={() => {}} />);
			expect(screen.getByText("Audio")).toBeTruthy();
			expect(originalCheckbox().checked).toBe(false);
		});

		it("hands the choice back on Save, leaving the color alone", () => {
			const onSave = vi.fn();
			render(<Harness onSave={onSave} />);
			fireEvent.click(originalCheckbox());
			fireEvent.click(screen.getByText("Save"));
			expect(onSave).toHaveBeenCalledWith({
				...DEFAULT_RADIO_TRAFFIC_SETTINGS,
				playOriginalAudio: true,
			});
		});

		// Same draft contract as the colour: ticking and then cancelling must
		// leave the listener on the copy they were already hearing.
		it("dispatches nothing when the listener ticks it and cancels", () => {
			const onSave = vi.fn();
			const onCancel = vi.fn();
			render(<Harness onSave={onSave} onCancel={onCancel} />);
			fireEvent.click(originalCheckbox());
			fireEvent.click(screen.getByText("Cancel"));
			expect(onCancel).toHaveBeenCalled();
			expect(onSave).not.toHaveBeenCalled();
		});

		it("opens showing the choice a previous session saved", () => {
			render(
				<Harness
					initial={{ ...DEFAULT_RADIO_TRAFFIC_SETTINGS, playOriginalAudio: true }}
					onSave={() => {}}
				/>,
			);
			expect(originalCheckbox().checked).toBe(true);
		});
	});
});
