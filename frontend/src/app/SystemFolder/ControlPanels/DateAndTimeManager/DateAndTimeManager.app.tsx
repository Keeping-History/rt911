'use client'

import { getClassicyAboutWindow } from '@/app/SystemFolder/SystemResources/AboutWindow/ClassicyAboutWindow'
import ClassicyApp from '@/app/SystemFolder/SystemResources/App/ClassicyApp'
import { quitAppHelper } from '@/app/SystemFolder/SystemResources/App/ClassicyAppUtils'
import { useDesktop, useDesktopDispatch } from '@/app/SystemFolder/ControlPanels/AppManager/ClassicyAppManagerContext'
import ClassicyButton from '@/app/SystemFolder/SystemResources/Button/ClassicyButton'
import ClassicyPopUpMenu from '@/app/SystemFolder/SystemResources/PopUpMenu/ClassicyPopUpMenu'
import { useSoundDispatch } from '@/app/SystemFolder/SystemResources/SoundManager/ClassicySoundManagerContext'
import ClassicyWindow from '@/app/SystemFolder/SystemResources/Window/ClassicyWindow'
import React from 'react'
import ClassicyControlGroup from '../../SystemResources/ControlGroup/ClassicyControlGroup'
import ClassicyDatePicker from "@/app/SystemFolder/SystemResources/DatePicker/ClassicyDatePicker";
import ClassicyTimePicker from "@/app/SystemFolder/SystemResources/TimePicker/ClassicyTimePicker";
import {ClassicyStore} from "@/app/SystemFolder/ControlPanels/AppManager/ClassicyAppManager";

export const DateAndTimeManagerApp: React.FC = () => {
    const appName: string = 'Date and Time Manager'
    const appId: string = 'DateAndTimeManager.app'
    const appIcon: string = `${process.env.NEXT_PUBLIC_BASE_PATH || ''}/img/icons/control-panels/date-time-manager/date-time-manager.png`

    const desktopContext = useDesktop(),
        desktopEventDispatch = useDesktopDispatch()

    const [showAbout, setShowAbout] = React.useState(false)

    const quitApp = () => {
        desktopEventDispatch(quitAppHelper(appId, appName, appIcon))
    }

    const appMenu = [
        {
            id: appId + '_file',
            title: 'File',
            menuChildren: [
                {
                    id: appId + '_quit',
                    title: 'Quit',
                    onClickFunc: quitApp,
                },
            ],
        },
        {
            id: appId + '_help',
            title: 'Help',
            menuChildren: [
                {
                    id: appId + '_about',
                    title: 'About',
                    onClickFunc: () => {
                        setShowAbout(true)
                    },
                },
            ],
        },
    ]

    const timezones = [
        {
            "label": "Pacific/Midway",
            "value": "-11"
        },
        {
            "label": "Pacific/Honolulu",
            "value": "-10"
        },
        {
            "label": "America/Anchorage",
            "value": "-8"
        },
        {
            "label": "America/Los_Angeles",
            "value": "-7"
        },
        {
            "label": "America/Denver",
            "value": "-6"
        },
        {
            "label": "America/Chicago",
            "value": "-5"
        },
        {
            "label": "America/New_York",
            "value": "-4"
        },
        {
            "label": "America/Halifax",
            "value": "-3"
        },
        {
            "label": "America/Noronha",
            "value": "-2"
        },
        {
            "label": "Atlantic/Cape_Verde",
            "value": "-1"
        },
        {
            "label": "Africa/Monrovia",
            "value": "0"
        },
        {
            "label": "Europe/London",
            "value": "1"
        },
        {
            "label": "Europe/Amsterdam",
            "value": "2"
        },
        {
            "label": "Europe/Athens",
            "value": "3"
        },
        {
            "label": "Europe/Samara",
            "value": "4"
        },
        {
            "label": "Asia/Tashkent",
            "value": "5"
        },
        {
            "label": "Asia/Dhaka",
            "value": "6"
        },
        {
            "label": "Asia/Bangkok",
            "value": "7"
        },
        {
            "label": "Asia/Chongqing",
            "value": "8"
        },
        {
            "label": "Asia/Tokyo",
            "value": "9"
        },
        {
            "label": "Australia/Brisbane",
            "value": "10"
        },
        {
            "label": "Australia/Canberra",
            "value": "11"
        },
        {
            "label": "Pacific/Fiji",
            "value": "12"
        },
        {
            "label": "Pacific/Auckland",
            "value": "13"
        },
        {
            "label": "Pacific/Apia",
            "value": "14"
        }
    ]

    return (
        <ClassicyApp id={appId} name={appName} icon={appIcon} defaultWindow={'DateAndTimeManager_1'} openOnBoot={true} noDesktopIcon={true} addSystemMenu={true}>
            <ClassicyWindow
                id={'DateAndTimeManager_1'}
                title={appName}
                appId={appId}
                icon={appIcon}
                closable={true}
                resizable={false}
                zoomable={false}
                scrollable={false}
                collapsable={false}
                initialSize={[325, 220]}
                initialPosition={[300, 50]}
                modal={true}
                appMenu={appMenu}
            >
                <div style={{display: 'flex', flexDirection: 'row'}}>
                    <div style={{width: '40%'}}>
                        <ClassicyControlGroup label={'Current Date'}>
                            <ClassicyDatePicker id={'date'} labelTitle={''} prefillValue={new Date(desktopContext.System.Manager.DateAndTime.dateTime)}></ClassicyDatePicker>
                        </ClassicyControlGroup>
                    </div>
                    <div style={{width: '60%'}}>
                        <ClassicyControlGroup label={'Current Time'}>
                            <ClassicyTimePicker id={'time'} labelTitle={''} prefillValue={new Date(desktopContext.System.Manager.DateAndTime.dateTime)}></ClassicyTimePicker>
                        </ClassicyControlGroup>
                    </div>
                </div>
                <div style={{display: 'flex', flexDirection: 'column'}}>
                    <ClassicyControlGroup label={'Timezone'}>
                        <ClassicyPopUpMenu
                            id={'timezone'}
                            small={false}
                            options={timezones}
                            selected={(new Date().getTimezoneOffset() / 60  * -1).toString()}
                        />
                    </ClassicyControlGroup>
                </div>
                <ClassicyButton isDefault={false} onClick={quitApp}>
                    Quit
                </ClassicyButton>
            </ClassicyWindow>

            {showAbout && getClassicyAboutWindow({ appId, appName, appIcon, hideFunc: () => setShowAbout(false) })}
        </ClassicyApp>
    )
}

export const classicyDateTimeManagerEventHandler = (ds: ClassicyStore, action) => {
    switch (action.type) {
        case 'ClassicyManagerDateTimeSet': {
            ds.System.Manager.DateAndTime.dateTime = action.dateTime.toISOString();
        }
    }
    return ds
}
