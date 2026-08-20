/**
 * The classic Mac OS disclosure triangle, rendered as a controlled glyph.
 *
 * Classicy's own <ClassicyDisclosure> owns its open state and bundles children,
 * which can't host aligned table columns. We reuse only its global CSS classes
 * (from "classicy/dist/classicy.css", imported in app.tsx) so the triangle is
 * pixel-identical while collapse state stays under our control. The polygon
 * geometry is copied verbatim from the classicy source.
 */
type DisclosureTriangleProps = {
	open: boolean;
};

export const DisclosureTriangle = ({ open }: DisclosureTriangleProps) => {
	const state = open ? "classicyDisclosureTriangleRightOpen" : "classicyDisclosureTriangleRightClosed";
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 6.44 11.12"
			className={`classicyDisclosureTriangle ${state}`}
			aria-hidden="true"
		>
			<title>Disclosure triangle</title>
			<polygon
				className="classicyDisclosureTriangleDropShadow"
				points="6.44 6.05 1.17 1.07 .93 11.12 6.44 6.05"
			/>
			<polygon
				className="classicyDisclosureTriangleOutline"
				points="5.68 5.34 0 0 0 10.68 5.68 5.34"
			/>
			<polygon
				className="classicyDisclosureTriangleHighlight"
				points="4.79 5.34 .76 1.82 .76 8.86 4.79 5.34"
			/>
			<polygon
				className="classicyDisclosureTriangleInner"
				points="4.79 5.34 1.27 3.42 1.29 8.43 4.79 5.34"
			/>
		</svg>
	);
};
