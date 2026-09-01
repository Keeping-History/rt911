// packages/frontend/src/Mobile/screens/ColorScreen.tsx
// Settings → Color: pick one of the five first-gen iPod mini finishes. Like
// the real iPod's settings lists, choosing a value stays on the screen and
// moves the checkmark, so the recolor is visible immediately.
import { useState } from "react";
import { IpodList } from "../IpodList";
import { useScreenWheel } from "../WheelContext";
import { IPOD_COLORS, type IpodColor } from "../ipodColorStore";

const COLOR_LABELS: Record<IpodColor, string> = {
	silver: "Silver",
	gold: "Gold",
	blue: "Blue",
	pink: "Pink",
	green: "Green",
};

interface ColorScreenProps {
	color: IpodColor;
	onColorChange: (color: IpodColor) => void;
}

export function ColorScreen({ color, onColorChange }: ColorScreenProps) {
	const [selectedIndex, setSelectedIndex] = useState(() =>
		Math.max(0, IPOD_COLORS.indexOf(color)),
	);

	const items = IPOD_COLORS.map((c) => ({
		key: c,
		label: COLOR_LABELS[c],
		value: c === color ? "✓" : undefined,
	}));

	const activate = (i: number) => {
		const next = IPOD_COLORS[i];
		if (next) onColorChange(next);
	};

	useScreenWheel({
		onScroll: (steps) =>
			setSelectedIndex((i) => Math.max(0, Math.min(IPOD_COLORS.length - 1, i + steps))),
		onSelect: () => activate(selectedIndex),
	});

	return (
		<IpodList
			items={items}
			selectedIndex={selectedIndex}
			onSelectedIndexChange={setSelectedIndex}
			onActivate={activate}
		/>
	);
}
