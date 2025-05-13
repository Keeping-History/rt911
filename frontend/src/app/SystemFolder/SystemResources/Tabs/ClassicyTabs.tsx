import classicyTabStyles from '@/app/SystemFolder/SystemResources/Tabs/ClassicyTabs.module.scss'
import React from 'react'

interface TabProps {
    tabs: TabIndividual[]
}

interface TabIndividual {
    title: string
    children: any,
}


const ClassicyTabs: React.FC<TabProps> = ({ tabs }) => {

    const [activeTab, setActiveTab] = React.useState(0)

    const handleTabClick = (e) => {
        e.stopPropagation()
        setActiveTab(parseInt(e.target.id))
    }

    return (
        <div className={classicyTabStyles.classicyTabContainer}>
            <div className={classicyTabStyles.classicyButtonsHolder}>
                {tabs.map((tab, index) => {
                    return (
                        <div key={"button_" + index.toString()} className={classicyTabStyles.classicyTabButtonWrapper}>
                            <button
                                id={index.toString()}
                                className={classicyTabStyles.classicyTabButton + ' ' + (index == activeTab ? classicyTabStyles.classicyTabButtonActive : '')}
                                onClick={handleTabClick}
                            >
                                {tab.title}
                            </button>
                        </div>
                    )
                })}
            </div>
            <div className={classicyTabStyles.classicyTabsHolder}>
                {tabs.map((tab, index) => {
                    return (
                        <div id={index.toString()} key={index.toString()}
                             className={index == activeTab ? classicyTabStyles.classicyTabActiveContent : classicyTabStyles.classicyTabHiddenContent} >
                            {tab.children}
                        </div>
                    )
                })}
            </div>
        </div>
    )
}

export default ClassicyTabs
