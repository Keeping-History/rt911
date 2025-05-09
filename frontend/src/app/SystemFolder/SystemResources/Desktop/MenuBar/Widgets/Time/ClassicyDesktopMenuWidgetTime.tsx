import classicyDesktopMenuWidgetTimeStyles from '@/app/SystemFolder/SystemResources/Desktop/MenuBar/Widgets/Time/ClassicyDesktopMenuWidgetTime.module.scss'
import classicyMenuStyles from '@/app/SystemFolder/SystemResources/Menu/ClassicyMenu.module.scss'
import classNames from 'classnames'
import React, {useContext} from 'react'
import {useDesktop, useDesktopDispatch} from "@/app/SystemFolder/ControlPanels/AppManager/ClassicyAppManagerContext";

type ClassicyDesktopMenuWidgetTimeProps = {
    hide?: boolean
    militaryTime?: boolean
    displaySeconds?: boolean
    displayPeriod?: boolean
    displayDay?: boolean
    displayLongDay?: boolean
    flashSeparators?: boolean
}

const ClassicyDesktopMenuWidgetTime: React.FC<ClassicyDesktopMenuWidgetTimeProps> = ({
                                                                                         hide = false,
                                                                                         militaryTime = false,
                                                                                         displaySeconds = false,
                                                                                         displayPeriod = true,
                                                                                         displayDay = true,
                                                                                         displayLongDay = false,
                                                                                         flashSeparators = true,
                                                                                     }) => {
    const desktopContext = useDesktop()
    const desktopEventDispatch = useDesktopDispatch()
    const [time, setTime] = React.useState({
        day: new Date(desktopContext.System.Manager.DateAndTime.dateTime).getDay(),
        minutes: new Date(desktopContext.System.Manager.DateAndTime.dateTime).getMinutes(),
        hours: new Date(desktopContext.System.Manager.DateAndTime.dateTime).getHours() === 0 ? 12 : new Date().getHours(),
        seconds: new Date(desktopContext.System.Manager.DateAndTime.dateTime).getSeconds(),
        period: new Date(desktopContext.System.Manager.DateAndTime.dateTime).getHours() >= 12 ? ' PM' : ' AM',
    })
    const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

    React.useEffect(() => {
        const intervalId = setInterval(() => {
            const date = new Date(desktopContext.System.Manager.DateAndTime.dateTime)
            date.setSeconds(date.getSeconds() + 1)
            setTime({
                day: date.getDay(),
                minutes: date.getMinutes(),
                hours: date.getHours() === 0 ? 12 : date.getHours(),
                seconds: date.getSeconds(),
                period: date.getHours() >= 12 ? ' PM' : ' AM',
            })
            desktopEventDispatch({
                type: 'ClassicyManagerDateTimeSet',
                dateTime: date,
            })
        }, 1000)

        return () => clearInterval(intervalId)
    }, [])

    const convertToTwoDigit = (number) => {
        return number.toLocaleString('en-US', {
            minimumIntegerDigits: 2,
        })
    }

    const convertTo12HourPeriod = (number) => {
        if (number > 12) {
            return number - 12
        }
        return number
    }

    const toBlink = () => {
        if (flashSeparators) {
            return classicyDesktopMenuWidgetTimeStyles.textBlinker
        }

        return
    }

    const openDateTimeManager = () => {
        desktopEventDispatch({
            type: 'ClassicyAppOpen',
            app: {
                id: "DateAndTimeManager.app",
                name: "Date and Time Manager",
                icon: `${process.env.NEXT_PUBLIC_BASE_PATH || ''}/img/icons/control-panels/date-time-manager/date-time-manager.png`
            },
        })
    }

    return (
        <>
            {!hide && (
                <li
                    className={classNames(
                        classicyMenuStyles.classicyMenuItem,
                        classicyMenuStyles.classicyMenuItemNoImage,
                        classicyDesktopMenuWidgetTimeStyles.classicyDesktopMenuTime
                    )}
                    onDoubleClick={openDateTimeManager}
                >
                    {displayDay && (
                        <span>{displayLongDay ? daysOfWeek[time.day] : daysOfWeek[time.day].slice(0, 3)}&nbsp;</span>
                    )}
                    <span> {militaryTime ? convertToTwoDigit(time.hours) : convertTo12HourPeriod(time.hours)}</span>
                    <span>
                        <span className={displaySeconds ? '' : toBlink()}>:</span>
                        {convertToTwoDigit(time.minutes)}
                    </span>
                    {displaySeconds && (
                        <span>
                            <span className={toBlink()}>:</span>
                            {convertToTwoDigit(time.seconds)}
                        </span>
                    )}
                    {!militaryTime && displayPeriod && <span>&nbsp;{time.hours >= 12 ? 'PM' : 'AM'}</span>}
                </li>
            )}
        </>
    )
}

export default ClassicyDesktopMenuWidgetTime
