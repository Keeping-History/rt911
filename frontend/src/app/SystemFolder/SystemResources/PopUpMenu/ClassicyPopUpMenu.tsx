import ClassicyControlLabel from '@/app/SystemFolder/SystemResources/ControlLabel/ClassicyControlLabel'
import classicyPopUpMenuStyle from '@/app/SystemFolder/SystemResources/PopUpMenu/ClassicyPopUpMenu.module.scss'
import classNames from 'classnames'
import React from 'react'

type classicyPopUpMenuOptions = {
    value: string
    label: string
}

type classicyPopUpMenuProps = {
    id: string
    label?: string
    options: classicyPopUpMenuOptions[]
    selected?: string
    small?: boolean
    onChangeFunc?: any
}
const ClassicyPopUpMenu: React.FC<classicyPopUpMenuProps> = ({
                                                                 id,
                                                                 label,
                                                                 options,
                                                                 selected,
                                                                 small = false,
                                                                 onChangeFunc,
                                                             }) => {

    const [selectedItem, setSelectedItem] = React.useState(selected)

    const onChangeHandler = (e) => {
        setSelectedItem(e.target.value)
        if (onChangeFunc) {
            onChangeFunc(e)
        }
    }

    return (
        <div className={classicyPopUpMenuStyle.classicyPopUpMenuWrapper}>
            {label && <ClassicyControlLabel label={label} direction={"right"}></ClassicyControlLabel>}
            <div
                style={{flexGrow: '2'}}
                className={classNames(
                    classicyPopUpMenuStyle.classicyPopUpMenu,
                    small ? classicyPopUpMenuStyle.classicyPopUpMenuSmall : ''
                )}
            >
                <select id={id} tabIndex={0} value={selectedItem} onChange={onChangeHandler}>
                    {options.map((o) => (
                        <option key={id + o.label + o.value} value={o.value}>
                            {o.label}
                        </option>
                    ))}
                </select>
            </div>
        </div>
    )
}
export default ClassicyPopUpMenu
