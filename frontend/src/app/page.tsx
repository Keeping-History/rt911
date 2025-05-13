'use client'

import SimpleText from '@/app/Applications/SimpleText/SimpleText'
import QuickTimeMoviePlayer from '@/app/Applications/QuickTime/QuickTimeMoviePlayer'
import {ClassicyDesktopProvider} from '@/app/SystemFolder/ControlPanels/AppManager/ClassicyAppManagerContext'
import ClassicyDesktop from '@/app/SystemFolder/SystemResources/Desktop/ClassicyDesktop'
import React from 'react'
import EPG from '@/app/Applications/EPG/EPG'

export default function Home() {
    return (
        <ClassicyDesktopProvider>
            <ClassicyDesktop>
                <EPG/>
                {/*<QuickTimeMoviePlayer/>*/}
                {/*<SimpleText/>*/}
            </ClassicyDesktop>
        </ClassicyDesktopProvider>
    )
}
