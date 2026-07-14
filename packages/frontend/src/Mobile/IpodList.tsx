// The shared menu list: wheel input moves the highlight (owned by the parent
// screen via selectedIndex), touch input taps rows directly. Both paths share
// one selection state, so the input modes never fight.
import { useEffect, useRef } from "react";

export interface IpodListItem {
	key: string;
	label: string;
	value?: string;
	arrow?: boolean;
	disabled?: boolean;
}

interface IpodListProps {
	items: IpodListItem[];
	selectedIndex: number;
	onSelectedIndexChange: (index: number) => void;
	onActivate: (index: number) => void;
}

export function IpodList({
	items,
	selectedIndex,
	onSelectedIndexChange,
	onActivate,
}: IpodListProps) {
	const listRef = useRef<HTMLUListElement>(null);

	useEffect(() => {
		listRef.current
			?.querySelector("li.selected")
			?.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	return (
		<ul className="ipodMenu" ref={listRef}>
			{items.map((item, i) => (
				// eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
				<li
					key={item.key}
					className={`ipodMenuItem${i === selectedIndex ? " selected" : ""}${item.disabled ? " disabled" : ""}`}
					onClick={() => {
						if (item.disabled) return;
						onSelectedIndexChange(i);
						onActivate(i);
					}}
				>
					<span className="label">{item.label}</span>
					{item.value !== undefined && <span className="value">{item.value}</span>}
					{item.arrow && <span className="arrow">{">"}</span>}
				</li>
			))}
		</ul>
	);
}
