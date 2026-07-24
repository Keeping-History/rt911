import { ClassicyTriangle } from "classicy";
import type React from "react";
import { type KeyboardEvent, useState } from "react";

// A collapsible section whose initial open state is controllable (classicy's
// ClassicyDisclosure always boots closed). Reuses classicy's global disclosure
// CSS (loaded app-wide) so the triangle + layout match the system look.
interface BookmarkDisclosureProps {
	label: string;
	defaultOpen?: boolean;
	children: React.ReactNode;
}

export const BookmarkDisclosure: React.FC<BookmarkDisclosureProps> = ({
	label,
	defaultOpen = false,
	children,
}) => {
	const [open, setOpen] = useState(defaultOpen);

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			setOpen((o) => !o);
		}
	};

	return (
		<div className="classicyDisclosure">
			{/* biome-ignore lint/a11y/useSemanticElements: mirrors classicy's own disclosure header (svg child incompatible with <button>) */}
			<div
				role="button"
				className="classicyDisclosureHeader"
				onClick={() => setOpen((o) => !o)}
				onKeyDown={onKeyDown}
				tabIndex={0}
				aria-expanded={open}
			>
				<ClassicyTriangle direction="right" open={open} interactive={false} />
				<span>{label}</span>
			</div>
			<div className={`classicyDisclosureInner ${open ? "classicyDisclosureInnerOpen" : "classicyDisclosureInnerClose"}`}>
				{children}
			</div>
		</div>
	);
};
