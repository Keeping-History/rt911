import ClassicyControlLabel from '@/app/SystemFolder/SystemResources/ControlLabel/ClassicyControlLabel'
import classicyTimePickerStyles from '@/app/SystemFolder/SystemResources/TimePicker/ClassicyTimePicker.module.scss'
import classNames from 'classnames'
import React from 'react'
import ClassicyPopUpMenu from "@/app/SystemFolder/SystemResources/PopUpMenu/ClassicyPopUpMenu";
import {useDesktop, useDesktopDispatch} from "@/app/SystemFolder/ControlPanels/AppManager/ClassicyAppManagerContext";

interface ClassicyTimePickerProps {
    id: string
    inputType?: 'text'
    onChangeFunc?: any
    labelTitle?: string
    placeholder?: string
    prefillValue?: Date
    disabled?: boolean
    isDefault?: boolean
    ref?: any
}

const ClassicyTimePicker: React.FC<ClassicyTimePickerProps> = React.forwardRef<HTMLInputElement, ClassicyTimePickerProps>(
    function ClassicyTimePicker(
        {id, inputType = 'text', labelTitle, placeholder, prefillValue, disabled = false, isDefault, onChangeFunc},
        ref
    ) {
        const desktop = useDesktop()
        const desktopEventDispatch = useDesktopDispatch()

        const [selectedDate, setSelectedDate] = React.useState<Date>(new Date(desktop.System.Manager.DateAndTime.dateTime))
        const [hour, setHour] = React.useState<string>((new Date(desktop.System.Manager.DateAndTime.dateTime).getHours()).toString())
        const [minutes, setMinutes] = React.useState<string>(new Date(desktop.System.Manager.DateAndTime.dateTime).getMinutes().toString())
        const [seconds, setSeconds] = React.useState<string>(new Date(desktop.System.Manager.DateAndTime.dateTime).getSeconds().toString())
        const [period, setPeriod] = React.useState<string>(new Date(desktop.System.Manager.DateAndTime.dateTime).getHours() < 12 ? "am" : "pm")

        const handleDateChange = (date: Date) => {
            desktopEventDispatch({
                type: 'ClassicyManagerDateTimeSet',
                dateTime: date,
                debug: true
            })
            if (onChangeFunc) {
                onChangeFunc()
            }
        }

        const handlePeriodChange = (e: React.ChangeEvent<HTMLInputElement>, part: 'hour' | 'minutes' | 'seconds' | 'period') => {
            setPeriod(e.target.value)

            let updatedDate = new Date(selectedDate)
            let hours = parseInt(hour)

            if (e.target.value == "pm") {
                hours += 12
            }

            updatedDate.setHours(hours)
            setSelectedDate(updatedDate)
            handleDateChange(updatedDate)
        }

        const handleTimePartChange = (e: React.ChangeEvent<HTMLInputElement>, part: 'hour' | 'minutes' | 'seconds') => {
            let inputValue = parseInt(e.currentTarget.value);

            if (isNaN(inputValue)) {
                return;
            }

            let updatedDate = new Date(selectedDate)

            switch (part) {
                case 'hour':
                    if (inputValue < 1 || inputValue > 12) {
                        setHour("1");
                        return;
                    }
                    if (period == "pm") {
                        inputValue += 12
                    }
                    updatedDate.setHours(inputValue);
                    setHour(e.currentTarget.value);
                    break;
                case 'minutes':
                    if (inputValue < 0 || inputValue > 59) {
                        return;
                    }
                    updatedDate.setMinutes(inputValue);
                    setMinutes(e.currentTarget.value);
                    break;
                case 'seconds':
                    if (inputValue < 0 || inputValue > 59) {
                        return;
                    }
                    updatedDate.setSeconds(inputValue);
                    setSeconds(e.currentTarget.value);
                    break;
            }

            setSelectedDate(updatedDate);
            handleDateChange(updatedDate);
        };

        return (
            <div className={classicyTimePickerStyles.classicyTimePickerHolder}>
                {labelTitle && (
                    <ClassicyControlLabel
                        label={labelTitle}
                        labelFor={id}
                        direction={'left'}
                        disabled={disabled}
                    ></ClassicyControlLabel>
                )}
                <div className={classNames(
                    classicyTimePickerStyles.classicyTimePicker,
                    isDefault ? classicyTimePickerStyles.classicyTimePickerDefault : ''
                )}
                >
                    <input
                        id={id + "_hour"}
                        tabIndex={0}
                        name={id}
                        type={inputType}
                        ref={ref}
                        disabled={disabled}
                        placeholder={placeholder}
                        onChange={(e) => handleTimePartChange(e, 'hour')}
                        onBlur={(e) => handleTimePartChange(e, 'hour')}
                        defaultValue={parseInt(hour) % 12}
                        maxLength={2}
                        style={{width: '50%'}}
                    ></input>
                    :
                    <input
                        id={id + "_minutes"}
                        tabIndex={0}
                        name={id}
                        type={inputType}
                        ref={ref}
                        disabled={disabled}
                        defaultValue={minutes}
                        onChange={(e) => handleTimePartChange(e, 'minutes')}
                        onBlur={(e) => handleTimePartChange(e, 'minutes')}
                        maxLength={2}
                        style={{width: '50%'}}
                    ></input>
                    :
                    <input
                        id={id + "_seconds"}
                        tabIndex={0}
                        name={id}
                        type={inputType}
                        ref={ref}
                        disabled={disabled}
                        defaultValue={seconds}
                        onChange={(e) => handleTimePartChange(e, 'seconds')}
                        onBlur={(e) => handleTimePartChange(e, 'seconds')}
                        maxLength={2}
                        style={{width: '50%'}}
                    ></input>
                </div>
                <ClassicyPopUpMenu selected={period} id={"am-pm"}
                                   options={[{label: "am", value: "am"}, {label: "pm", value: "pm"}]}
                                   onChangeFunc={handlePeriodChange}></ClassicyPopUpMenu>
            </div>
        )
    }
)

export default ClassicyTimePicker
