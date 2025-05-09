'use client'

import {AppearanceManager} from '@/app/SystemFolder/ControlPanels/AppearanceManager/AppearanceManager'
import {SoundManager} from '@/app/SystemFolder/ControlPanels/SoundManager/SoundManager'
import React from 'react'
import {DateAndTimeManagerApp} from "@/app/SystemFolder/ControlPanels/DateAndTimeManager/DateAndTimeManager.app";

export default function ClassicyControlPanels() {
    return (
        <>
            <AppearanceManager/>
            <SoundManager/>
            <DateAndTimeManagerApp/>
        </>
    )
}
