import { ClassicyMenuItem } from '@/app/SystemFolder/SystemResources/Menu/ClassicyMenu'
import {
    ClassicyStore,
    ClassicyStoreSystemManager,
} from '@/app/SystemFolder/ControlPanels/AppManager/ClassicyAppManager'

export interface ClassicyStoreSystemDesktopManagerIcon {
    appId: string
    appName: string
    icon: string
    label?: string
    kind?: 'app_shortcut' | 'file'
    location?: [number, number]
    onClickFunc: (event: MouseEvent) => void
}

export interface ClassicyStoreSystemDesktopManager extends ClassicyStoreSystemManager {
    selectedIcons?: string[]
    systemMenu: ClassicyMenuItem[]
    appMenu: ClassicyMenuItem[]
    contextMenu: ClassicyMenuItem[]
    showContextMenu: boolean
    icons: ClassicyStoreSystemDesktopManagerIcon[]
    selectBox: {
        size: [number, number]
        start: [number, number]
        active: boolean
    }
}

export const classicyDesktopEventHandler = (ds: ClassicyStore, action) => {
    switch (action.type) {
        case 'ClassicyDesktopAppMenuAdd': {
            const menuItem = {
                id: "system_menu" +  action.app.id,
                title: action.app.name,
                image: action.app.icon,
                event: "ClassicyAppOpen",
                eventData: {
                    app: {
                        id: action.app.id,
                        name: action.app.name,
                        icon: action.app.icon,
                    },
                }
            }

            const exists = ds.System.Manager.Desktop.systemMenu.findIndex((i) => i.id === menuItem.id )
            if (exists >= 0) {
                ds.System.Manager.Desktop.systemMenu[exists] = menuItem
            } else {
                ds.System.Manager.Desktop.systemMenu.push(menuItem)
            }

            break
        }
        case 'ClassicyDesktopFocus': {
            if ('e' in action && action.e.target.id === 'classicyDesktop') {
                ds.System.Manager.App.apps = ds.System.Manager.App.apps.map((a) => {
                    a.focused = false
                    a.windows = a.windows.map((w) => {
                        w.focused = false
                        return w
                    })
                    return a
                })

                const appI = ds.System.Manager.App.apps.findIndex((a) => (a.id = 'Finder.app'))
                ds.System.Manager.App.apps[appI].focused = true
                ds.System.Manager.Desktop.selectedIcons = []
                ds.System.Manager.Desktop.showContextMenu = false
                ds.System.Manager.Desktop.selectBox.active = true
                ds.System.Manager.Desktop.selectBox.start = [action.e.clientX, action.e.client]
            }

            if ('menuBar' in action) {
                ds.System.Manager.Desktop.appMenu = action.menuBar
            }

            break
        }
        case 'ClassicyDesktopDoubleClick': {
            break
        }
        case 'ClassicyDesktopDrag': {
            ds.System.Manager.Desktop.selectBox.start = [
                action.e.clientX - ds.System.Manager.Desktop.selectBox.start[0],
                action.e.clientY - ds.System.Manager.Desktop.selectBox.start[1],
            ]

            ds.System.Manager.Desktop.selectBox.size = [0, 0]
            break
        }
        case 'ClassicyDesktopStop': {
            ds.System.Manager.Desktop.selectBox.active = false
            ds.System.Manager.Desktop.selectBox.size = [0, 0]
            ds.System.Manager.Desktop.selectBox.start = [0, 0]
            break
        }
        case 'ClassicyDesktopContextMenu': {
            ds.System.Manager.Desktop.showContextMenu = action.showContextMenu
            if (action.contextMenu) {
                ds.System.Manager.Desktop.contextMenu = action.contextMenu
            }
            break
        }
        case 'ClassicyDesktopChangeTheme': {
            ds.System.Manager.Appearance.activeTheme = ds.System.Manager.Appearance.availableThemes.find(
                (a) => a.id == action.activeTheme
            )
            break
        }
        case 'ClassicyDesktopChangeBackground': {
            ds.System.Manager.Appearance.activeTheme.desktop.backgroundImage = action.backgroundImage
            ds.System.Manager.Appearance.activeTheme.desktop.backgroundSize = "auto"
            break
        }
        case 'ClassicyDesktopChangeFont': {
            switch (action.fontType) {
                case 'body':
                    ds.System.Manager.Appearance.activeTheme.typography.body = action.font
                    break
                case 'ui':
                    ds.System.Manager.Appearance.activeTheme.typography.ui = action.font
                    break
                case 'header':
                    ds.System.Manager.Appearance.activeTheme.typography.header = action.font
                    break
            }
            break
        }
        case 'ClassicyDesktopLoadThemes': {
            ds.System.Manager.Appearance.availableThemes = action.availableThemes
        }
    }
    return ds
}
