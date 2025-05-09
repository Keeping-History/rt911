'use client'

import SimpleText from '@/app/Applications/SimpleText/SimpleText'
import ClassicyControlPanels from '@/app/SystemFolder/ControlPanels/ClassicyControlPanels'
import {ClassicyDesktopProvider} from '@/app/SystemFolder/ControlPanels/AppManager/ClassicyAppManagerContext'
import ClassicyDesktop from '@/app/SystemFolder/SystemResources/Desktop/ClassicyDesktop'
import React from 'react'
import QuickTimeMoviePlayer from '@/app/Applications/QuickTime/QuickTimeMoviePlayer'
import EPG from '@/app/Applications/EPG/EPG'

export default function Home() {
    return (
        <ClassicyDesktopProvider>
            <ClassicyDesktop>
                {/*<EPG/>*/}
                {/*<QuickTimeMoviePlayer/>*/}
                {/*<SimpleText/>*/}
            </ClassicyDesktop>
        </ClassicyDesktopProvider>
    )
}
