import {
    ClassicyButton,
    ClassicyCheckbox,
    ClassicyColorPicker,
    ClassicyControlGroup,
    ClassicyControlLabel,
    ClassicyRadioInput,
    ClassicySlider,
    ClassicyWindow,
    MAC_OS_8_CRAYONS,
} from "classicy";
import type React from "react";
import type { ChangeEvent, ComponentProps, Dispatch, SetStateAction } from "react";
import styles from "./radio.module.scss";
import {
    CAPTION_FONT_VARS,
    isVizMode,
    type RadioScannerSettings,
    VIZ_MODES,
} from "./radioScannerSettings";

interface RadioSettingsWindowProps {
    appId: string;
    appIcon: string;
    appMenu: ComponentProps<typeof ClassicyWindow>["appMenu"];
    /** Control-id prefix, e.g. "radioscanner_settings" — keeps ids unique per app. */
    idPrefix: string;
    form: RadioScannerSettings;
    setForm: Dispatch<SetStateAction<RadioScannerSettings>>;
    onCancel: () => void;
    onSave: () => void;
}

/**
 * The Settings window shared by Radio Scanner and Radio Tuner — both apps
 * persist the same RadioScannerSettings shape (waveform, captions, volume),
 * each under its own appId. Draft-style: the parent seeds `form` from persisted
 * settings on open and dispatches only on Save.
 *
 * `playOriginalAudio` is part of that shape but is deliberately NOT rendered
 * here any more. It chooses the source recording over the noise-reduced render,
 * which is a question about comm traffic — Radio Traffic's subject, not the
 * Tuner's fourteen continuous broadcasters — so the control moved to that app's
 * own Settings window. Both players still honour a value a previous session
 * saved; nothing in this window can change one.
 */
export const RadioSettingsWindow: React.FC<RadioSettingsWindowProps> = ({
    appId,
    appIcon,
    appMenu,
    idPrefix,
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
            <ClassicyControlGroup label="Waveform Style">
                <ClassicyRadioInput
                    name={`${idPrefix}_viz_mode`}
                    inputs={VIZ_MODES.map((m) => ({
                        id: m,
                        label: m,
                        checked: form.vizMode === m,
                    }))}
                    onClickFunc={(id: string) =>
                        setForm((f) =>
                            isVizMode(id) ? { ...f, vizMode: id } : f,
                        )
                    }
                />
            </ClassicyControlGroup>
            <ClassicyControlGroup label="Waveform Colors">
                <ClassicyCheckbox
                    id={`${idPrefix}_use_theme`}
                    label="Use theme colors"
                    checked={form.useThemeColors}
                    onClickFunc={(checked: boolean) =>
                        setForm((f) => ({
                            ...f,
                            useThemeColors: checked,
                        }))
                    }
                />
                {!form.useThemeColors && (
                    <>
                        <ClassicyColorPicker
                            id={`${idPrefix}_color_bright`}
                            labelTitle="Bright"
                            value={form.colorBright}
                            crayons={MAC_OS_8_CRAYONS}
                            onChangeFunc={(color: number) =>
                                setForm((f) => ({
                                    ...f,
                                    colorBright: color,
                                }))
                            }
                        />
                        <ClassicyColorPicker
                            id={`${idPrefix}_color_dim`}
                            labelTitle="Dim"
                            value={form.colorDim}
                            crayons={MAC_OS_8_CRAYONS}
                            onChangeFunc={(color: number) =>
                                setForm((f) => ({
                                    ...f,
                                    colorDim: color,
                                }))
                            }
                        />
                    </>
                )}
            </ClassicyControlGroup>
            <ClassicyControlGroup label="Volume">
                <ClassicySlider
                    id={`${idPrefix}_max_volume`}
                    labelTitle="Max volume:"
                    labelPosition="left"
                    value={form.maxVolume}
                    min={0}
                    max={100}
                    step={1}
                    tickInterval={10}
                    valueLabel={`${form.maxVolume}%`}
                    onChangeFunc={(e: ChangeEvent<HTMLInputElement>) =>
                        setForm((f) => ({
                            ...f,
                            maxVolume: parseInt(e.target.value, 10),
                        }))
                    }
                />
            </ClassicyControlGroup>
            <ClassicyControlGroup label="Captions">
                <ClassicyControlLabel label="Font" />
                <div className={styles.rsCaptionFontRow}>
                    {CAPTION_FONT_VARS.map(([varName, label]) => (
                        <ClassicyButton
                            key={varName}
                            buttonSize="small"
                            margin="sm"
                            padding="sm"
                            depressed={form.captionStyle.font === varName}
                            onClickFunc={() =>
                                setForm((f) => ({
                                    ...f,
                                    captionStyle: {
                                        ...f.captionStyle,
                                        font: varName,
                                    },
                                }))
                            }
                        >
                            {label}
                        </ClassicyButton>
                    ))}
                </div>
                <ClassicyColorPicker
                    id={`${idPrefix}_cc_text_color`}
                    labelTitle="Text Color"
                    value={form.captionStyle.color}
                    crayons={MAC_OS_8_CRAYONS}
                    onChangeFunc={(color: number) =>
                        setForm((f) => ({
                            ...f,
                            captionStyle: {
                                ...f.captionStyle,
                                color,
                            },
                        }))
                    }
                />
                <ClassicySlider
                    id={`${idPrefix}_cc_text_opacity`}
                    labelTitle="Text Opacity"
                    labelPosition="left"
                    value={form.captionStyle.colorOpacity}
                    min={0}
                    max={1}
                    step={0.05}
                    valueLabel={`${Math.round(
                        form.captionStyle.colorOpacity * 100,
                    )}%`}
                    onChangeFunc={(e: ChangeEvent<HTMLInputElement>) =>
                        setForm((f) => ({
                            ...f,
                            captionStyle: {
                                ...f.captionStyle,
                                colorOpacity: parseFloat(e.target.value),
                            },
                        }))
                    }
                />
                <ClassicyColorPicker
                    id={`${idPrefix}_cc_bg_color`}
                    labelTitle="Background Color"
                    value={form.captionStyle.bgColor}
                    crayons={MAC_OS_8_CRAYONS}
                    onChangeFunc={(color: number) =>
                        setForm((f) => ({
                            ...f,
                            captionStyle: {
                                ...f.captionStyle,
                                bgColor: color,
                            },
                        }))
                    }
                />
                <ClassicySlider
                    id={`${idPrefix}_cc_bg_opacity`}
                    labelTitle="Background Opacity"
                    labelPosition="left"
                    value={form.captionStyle.bgOpacity}
                    min={0}
                    max={1}
                    step={0.05}
                    valueLabel={`${Math.round(form.captionStyle.bgOpacity * 100)}%`}
                    onChangeFunc={(e: ChangeEvent<HTMLInputElement>) =>
                        setForm((f) => ({
                            ...f,
                            captionStyle: {
                                ...f.captionStyle,
                                bgOpacity: parseFloat(e.target.value),
                            },
                        }))
                    }
                />
                <ClassicySlider
                    id={`${idPrefix}_cc_size`}
                    labelTitle="Size"
                    labelPosition="left"
                    value={form.captionStyle.size}
                    min={50}
                    max={200}
                    step={10}
                    tickInterval={10}
                    valueLabel={`${form.captionStyle.size}%`}
                    onChangeFunc={(e: ChangeEvent<HTMLInputElement>) =>
                        setForm((f) => ({
                            ...f,
                            captionStyle: {
                                ...f.captionStyle,
                                size: parseInt(e.target.value, 10),
                            },
                        }))
                    }
                />
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
