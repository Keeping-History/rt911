import {
	ClassicyButton,
	ClassicyCheckbox,
	ClassicyColorPicker,
	ClassicyControlGroup,
	ClassicyWindow,
	MAC_OS_8_CRAYONS,
} from "classicy";
import type React from "react";
import type { ComponentProps, Dispatch, SetStateAction } from "react";
import styles from "../radio-core/radio.module.scss";
import type { RadioTrafficSettings } from "./RadioTrafficContext";

interface RadioTrafficSettingsWindowProps {
	appId: string;
	appIcon: string;
	appMenu: ComponentProps<typeof ClassicyWindow>["appMenu"];
	form: RadioTrafficSettings;
	setForm: Dispatch<SetStateAction<RadioTrafficSettings>>;
	onCancel: () => void;
	onSave: () => void;
}

/**
 * Radio Traffic's Settings window.
 *
 * A sibling of radio-core's RadioSettingsWindow rather than a reuse of it, and
 * deliberately so. That window is typed to `RadioScannerSettings` and renders
 * all of it — viz mode, max volume, five caption controls — none of which Radio
 * Traffic has or wants. Making it serve both would mean a union settings type
 * plus a which-sections-to-show prop threaded through a window the *live* Radio
 * Tuner renders, to gain a colour picker and a checkbox.
 *
 * The one control that crossed the other way is "Play original recording": it
 * describes the noise-reduced render of comm traffic, which is this app's
 * subject and not the Tuner's fourteen continuous broadcasters, so it now lives
 * here and no longer there.
 *
 * What is shared is the shape, control for control: the same modal
 * ClassicyWindow, the same ClassicyControlGroup sections, the same
 * "theme colours" checkbox gating the same crayon picker, the same draft model
 * (the parent seeds `form` on open and dispatches only on Save, so Cancel is
 * genuinely free), and the same stylesheet — `.rsSettings` is settings-window
 * layout, already shared by the Scanner and the Tuner, and a third copy of it
 * under a different prefix would be twelve lines of duplicated CSS.
 */
export const RadioTrafficSettingsWindow: React.FC<RadioTrafficSettingsWindowProps> = ({
	appId,
	appIcon,
	appMenu,
	form,
	setForm,
	onCancel,
	onSave,
}) => (
	<ClassicyWindow
		id={`${appId}_settings`}
		title="Settings"
		icon={appIcon}
		appId={appId}
		closable={true}
		resizable={false}
		zoomable={false}
		scrollable={false}
		collapsable={false}
		initialSize={[370, 0]}
		initialPosition={[250, 150]}
		modal={true}
		appMenu={appMenu}
		onCloseFunc={onCancel}
	>
		<div className={styles.rsSettings}>
			<ClassicyControlGroup label="Audio">
				<ClassicyCheckbox
					id="radiotraffic_settings_play_original"
					label="Play original recording (more noise)"
					checked={form.playOriginalAudio}
					onClickFunc={(checked: boolean) =>
						setForm((f) => ({ ...f, playOriginalAudio: checked }))
					}
				/>
			</ClassicyControlGroup>
			<ClassicyControlGroup label="Waveform Color">
				<ClassicyCheckbox
					id="radiotraffic_settings_use_theme"
					label="Use theme colors"
					checked={form.useThemeWaveformColor}
					onClickFunc={(checked: boolean) =>
						setForm((f) => ({ ...f, useThemeWaveformColor: checked }))
					}
				/>
				{/* Hidden rather than disabled while the theme is in charge: a
				    picker showing a colour that is not the one on screen invites
				    the listener to fix a value that is already being ignored. Same
				    call RadioSettingsWindow makes for its bright/dim pair. */}
				{!form.useThemeWaveformColor && (
					<ClassicyColorPicker
						id="radiotraffic_settings_waveform_color"
						labelTitle="Waveform"
						value={form.waveformColor}
						crayons={MAC_OS_8_CRAYONS}
						onChangeFunc={(color: number) =>
							setForm((f) => ({ ...f, waveformColor: color }))
						}
					/>
				)}
			</ClassicyControlGroup>
			<div className={styles.rsSettingsButtons}>
				<ClassicyButton onClickFunc={onCancel}>Cancel</ClassicyButton>
				<ClassicyButton isDefault={true} onClickFunc={onSave}>
					Save
				</ClassicyButton>
			</div>
		</div>
	</ClassicyWindow>
);
