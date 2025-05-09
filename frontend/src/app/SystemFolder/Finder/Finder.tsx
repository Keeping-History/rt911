import ClassicyApp from '@/app/SystemFolder/SystemResources/App/ClassicyApp'
import { useDesktop, useDesktopDispatch } from '@/app/SystemFolder/ControlPanels/AppManager/ClassicyAppManagerContext'
import ClassicyFileBrowser from '@/app/SystemFolder/SystemResources/File/ClassicyFileBrowser'
import { ClassicyFileSystem } from '@/app/SystemFolder/SystemResources/File/ClassicyFileSystem'
import ClassicyWindow from '@/app/SystemFolder/SystemResources/Window/ClassicyWindow'
import React, {useEffect, useMemo} from 'react'
import { quitAppHelper } from '@/app/SystemFolder/SystemResources/App/ClassicyAppUtils'

const Finder = () => {
    const appName: string = 'Finder'
    const appId: string = 'Finder.app'
    const appIcon: string = `${process.env.NEXT_PUBLIC_BASE_PATH}/img/icons/system/macos.svg`
    const desktopEventDispatch = useDesktopDispatch()
    const desktop = useDesktop()

    const [openPaths, setOpenPaths] = React.useState<string[]>([])
    const [pathSettings, setPathSettings] = React.useState<Record<string, PathSettingsProps>>({})

    type PathSettingsProps = {
        _viewType: 'list' | 'icons'
    }

    useEffect(() => {
        const appIndex = desktop.System.Manager.App.apps.findIndex((app) => app.id === appId)
        const appData = desktop.System.Manager.App.apps[appIndex].data || {}
        if (!appData?.hasOwnProperty('openPaths')) {
            appData["openPaths"] = []
        }
        desktop.System.Manager.App.apps[appIndex].data = appData
        setOpenPaths(appData['openPaths'])
    }, [])

    const handlePathSettingsChange = (path: string, settings: PathSettingsProps) => {
        let updatedPathSettings = { ...pathSettings }
        updatedPathSettings[path] = settings
        setPathSettings(updatedPathSettings)
    }

    const openFolder = (path: string) => {
        const p = new Set([...openPaths, path])
        setOpenPaths([...p])
        const appIndex = desktop.System.Manager.App.apps.findIndex((app) => app.id === appId)
        desktop.System.Manager.App.apps[appIndex].data['openPaths'] = Array.from(new Set([...desktop.System.Manager.App.apps[appIndex].data['openPaths'], path]))
        const windowIndex = desktop.System.Manager.App.apps[appIndex].windows.findIndex((w) => w.id === path)
        const ws = desktop.System.Manager.App.apps[appIndex].windows[windowIndex]
        ws.closed = false
        desktopEventDispatch({
            type: 'ClassicyWindowOpen',
            window: ws,
            app: {
                id: appId,
            },
        })
        desktopEventDispatch({
            type: 'ClassicyWindowFocus',
            app: {
                id: appId,
            },
            window: ws,

        })
    }

    const openFile = (path: string) => {
        // TODO: Need to write this logic
    }
    const closeFolder = (path: string) => {
        const appIndex = desktop.System.Manager.App.apps.findIndex((app) => app.id === appId)
        desktop.System.Manager.App.apps[appIndex].data['openPaths'] = desktop.System.Manager.App.apps[appIndex].data['openPaths'].filter((e) => e !== path.replace('Finder:', ''))
    }

    const emptyTrash = () => {
        desktopEventDispatch({
            type: 'ClassicyFinderEmptyTrash',
        })
    }

    const quitApp = () => {
        desktopEventDispatch(quitAppHelper(appId, appName, appIcon))
    }

    const closeWindow = (path: string) => {
        const updatedPaths = openPaths.filter((p) => p !== path)
        const appIndex = desktop.System.Manager.App.apps.findIndex((app) => app.id === appId)
        desktop.System.Manager.App.apps[appIndex].data['openPaths'] = updatedPaths

        setOpenPaths(updatedPaths)
        if (updatedPaths.length == 0) {
            desktopEventDispatch(quitAppHelper(appId, appName, appIcon))
        }
    }

    const fs = React.useMemo(() => new ClassicyFileSystem(''), [])

    // React.useEffect(() => {
    //     const drives = fs.filterByType('', 'drive')
    //
    //     Object.entries(drives).forEach(([a, b]) => {
    //         console.log(a)
    //         const openFolderFunc = () => {
    //             openFolder(a)
    //         }
    //         desktopEventDispatch({
    //             type: 'ClassicyDesktopIconAdd',
    //             app: {
    //                 id: appId,
    //                 name: a,
    //                 icon: b['_icon'],
    //                 onClickFunc: openFolderFunc,
    //             },
    //             kind: '_drive',
    //         })
    //     })
    //
    // }, [fs])

    const getHeaderString = (dir) => {
        return (
            dir['_count'] +
            ' items' +
            (dir['_countHidden'] ? ' (' + dir['_countHidden'] + ' hidden)' : '') +
            ', ' +
            fs.formatSize(dir['_size'])
        )
    }

    return (
        <ClassicyApp
            id={appId}
            name={appName}
            icon={appIcon}
            noDesktopIcon={true}
            defaultWindow={openPaths ? appName + ':' + openPaths.at(0) : "Macintosh HD"}
        >
            {openPaths
                .map((op) => {
                    return {
                        op,
                        dir: fs.statDir(op),
                    }
                })
                .map(({ op, dir }, idx) => {
                    return (
                        <ClassicyWindow
                            id={op}
                            key={appName + ':' + op}
                            title={dir['_name']}
                            icon={`${process.env.NEXT_PUBLIC_BASE_PATH}${dir['_icon']}`}
                            appId={appId}
                            hidden={false}
                            initialSize={[425, 300]}
                            initialPosition={[50 + idx * 50, 50 + idx * 50]}
                            header={<span>{getHeaderString(dir)}</span>}
                            onCloseFunc={closeFolder}
                            appMenu={[
                                {
                                    id: appId + '_' + op + '_file',
                                    title: 'File',
                                    menuChildren: [
                                        {
                                            id: appId + '_' + op + '_file_closew',
                                            title: 'Close Window',
                                            onClickFunc: () => closeWindow(op),
                                        },
                                        {
                                            id: appId + '_' + op + '_file_closews',
                                            title: 'Close All Windows',
                                            onClickFunc: quitApp,
                                        },
                                    ],
                                },
                                {
                                    id: appId + '_view',
                                    title: 'View',
                                    menuChildren: [
                                        {
                                            id: appId + '_' + op + '_view_as_icons',
                                            title: 'View as Icons',
                                            onClickFunc: () => handlePathSettingsChange(op, { _viewType: 'icons' }),
                                        },
                                        {
                                            id: appId + '_' + op + '_view_as_list',
                                            title: 'View as List',
                                            onClickFunc: () => handlePathSettingsChange(op, { _viewType: 'list' }),
                                        },
                                    ],
                                },
                                {
                                    id: appId + '_' + op + '_help',
                                    title: 'Help',
                                    menuChildren: [
                                        {
                                            id: appId + '_' + op + '_help_about',
                                            title: 'About',
                                            onClickFunc: () => {},
                                        },
                                    ],
                                },
                            ]}
                        >
                            <ClassicyFileBrowser
                                appId={appId}
                                fs={fs}
                                path={op}
                                dirOnClickFunc={openFolder}
                                fileOnClickFunc={openFile}
                                display={pathSettings[op]?._viewType || 'list'}
                            />
                        </ClassicyWindow>
                    )
                })}
        </ClassicyApp>
    )
}

export default Finder
