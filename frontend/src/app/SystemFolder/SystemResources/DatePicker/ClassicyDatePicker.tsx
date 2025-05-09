import ClassicyControlLabel from '@/app/SystemFolder/SystemResources/ControlLabel/ClassicyControlLabel'
import classicyDatePickerStyles from '@/app/SystemFolder/SystemResources/DatePicker/ClassicyDatePicker.module.scss'
import classNames from 'classnames'
import React from 'react'
import {useDesktop, useDesktopDispatch} from "@/app/SystemFolder/ControlPanels/AppManager/ClassicyAppManagerContext";

interface ClassicyDatePickerProps {
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

const monthsAndDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const ClassicyDatePicker: React.FC<ClassicyDatePickerProps> = React.forwardRef<HTMLInputElement, ClassicyDatePickerProps>(
    function ClassicyDatePicker(
        {id, inputType = 'text', labelTitle, placeholder, prefillValue, disabled = false, isDefault, onChangeFunc},
        ref
    ) {
        const desktop = useDesktop()
        const desktopEventDispatch = useDesktopDispatch()

        const [selectedDate, setSelectedDate] = React.useState<Date>(new Date(desktop.System.Manager.DateAndTime.dateTime))
        const [month, setMonth] = React.useState<string>((new Date(desktop.System.Manager.DateAndTime.dateTime).getMonth() + 1).toString())
        const [day, setDay] = React.useState<string>(new Date(desktop.System.Manager.DateAndTime.dateTime).getDate().toString())
        const [year, setYear] = React.useState<string>(new Date(desktop.System.Manager.DateAndTime.dateTime).getFullYear().toString())


        const handleDateChange = () => {
            desktopEventDispatch({
                type: 'ClassicyManagerDateTimeSet',
                dateTime: selectedDate,
            })
            if (onChangeFunc) {
                onChangeFunc()
            }
        }

        const selectText = (e) => {
            e.target.focus()
            e.target.select()
        }

        const handleDatePartChange = (e: React.ChangeEvent<HTMLInputElement>, part: 'month' | 'day' | 'year') => {
            let inputValue = parseInt(e.currentTarget.value);

            if (isNaN(inputValue)) {
                return;
            }

            let updatedDate = new Date(selectedDate); // Create a new Date object to avoid mutating state directly

            switch (part) {
                case 'month':
                    inputValue--;
                    if (inputValue < 0 || inputValue > 11) {
                        setMonth("1");
                        return;
                    }
                    updatedDate.setMonth(inputValue);
                    setMonth(e.currentTarget.value);
                    break;
                case 'day':
                    if (inputValue < 1 || inputValue > 31) {
                        return;
                    }
                    const monthInt = updatedDate.getMonth();
                    if (inputValue > monthsAndDays[monthInt]) return;
                    updatedDate.setDate(inputValue);
                    setDay(e.currentTarget.value);
                    break;
                case 'year':
                    if (inputValue < 0) {
                        return;
                    }
                    updatedDate.setFullYear(inputValue);
                    setYear(e.currentTarget.value);
                    break;
            }

            setSelectedDate(updatedDate);
            handleDateChange();
        };

        return (
            <>
                <div className={classicyDatePickerStyles.classicyDatePickerHolder}>
                    {labelTitle && (
                        <ClassicyControlLabel
                            label={labelTitle}
                            labelFor={id}
                            direction={'left'}
                            disabled={disabled}
                        ></ClassicyControlLabel>
                    )}
                    <div className={classNames(
                        classicyDatePickerStyles.classicyDatePicker,
                        isDefault ? classicyDatePickerStyles.classicyDatePickerDefault : ''
                    )}
                    >
                        <input
                            id={id + "_month"}
                            tabIndex={0}
                            onChange={(e) => handleDatePartChange(e, 'month')}
                            onBlur={(e) => handleDatePartChange(e, 'month')}
                            onClick={selectText}
                            name={id + "_month"}
                            type={inputType}
                            ref={ref}
                            disabled={disabled}
                            value={month}
                            maxLength={2}
                            style={{width: '25%'}}
                        ></input>
                        /
                        <input
                            id={id + "_day"}
                            tabIndex={0}
                            onChange={(e) => handleDatePartChange(e, 'day')}
                            onBlur={(e) => handleDatePartChange(e, 'day')}
                            onClick={selectText}
                            name={id + "_day"}
                            type={inputType}
                            ref={ref}
                            disabled={disabled}
                            value={day}
                            maxLength={2}
                            style={{width: '25%'}}
                        ></input>
                        /
                        <input
                            id={id + "_year"}
                            tabIndex={0}
                            onClick={selectText}
                            onChange={(e) => handleDatePartChange(e, 'year')}
                            onBlur={(e) => handleDatePartChange(e, 'year')}
                            name={id + "_year"}
                            type={inputType}
                            ref={ref}
                            disabled={disabled}
                            value={year}
                            maxLength={4}
                            style={{width: '50%'}}
                        ></input>
                    </div>
                </div>
            </>
        )
    }
)

export default ClassicyDatePicker
