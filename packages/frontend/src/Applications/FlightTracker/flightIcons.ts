import type { AircraftFamily } from "./aircraftModels";

// Plane icon pipeline: MapLibre symbol layers consume pre-registered raster
// images, not SVGs, and non-SDF icons can't be recolored via paint. So the
// pin colors are baked in here: inject the fill into the SVG string,
// rasterize, and (re)install the image on the map when a color changes.
export const PLANE_ICON_ID = "plane-icon";
export const PLANE_NOTABLE_ICON_ID = "plane-notable-icon";
export const PLANE_ICON_PX = 12; // display size; rasterized at 2× (pixelRatio 2)
export const PLANE_NOTABLE_ICON_PX = 32;

// The art (a single path with no fill of its own) inherits the root fill.
export const colorizeSvg = (svg: string, fill: string): string =>
	svg.replace("<svg ", `<svg fill="${fill}" `);

export const buildPlaneImage = (
	svg: string,
	fill: string,
	displayPx: number,
): Promise<ImageData> =>
	new Promise((resolve, reject) => {
		const px = displayPx * 2;
		const img = new Image();
		img.onload = () => {
			const canvas = document.createElement("canvas");
			canvas.width = px;
			canvas.height = px;
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				reject(new Error("2d canvas unavailable"));
				return;
			}
			ctx.drawImage(img, 0, 0, px, px);
			resolve(ctx.getImageData(0, 0, px, px));
		};
		img.onerror = () => reject(new Error("plane icon SVG failed to load"));
		img.src = `data:image/svg+xml,${encodeURIComponent(colorizeSvg(svg, fill))}`;
	});

// Per-family display sizes for the 2D silhouettes (issue: 2D per-family
// icons). Span-based: floor 9px keeps regional jets clickable, cap 16px
// keeps wide-bodies inside their symbol slot at national zoom. generic
// stays at the legacy PLANE_ICON_PX so the fallback icon's size is
// unchanged. The zoom icon-size expression multiplies on top of these.
export const FAMILY_ICON_PX: Record<AircraftFamily, number> = {
	generic: 12,
	b727: 12,
	b737: 12,
	b757: 13,
	b767: 15,
	b777: 16,
	md80: 12,
	dc10: 15,
	a319: 12,
	a320: 12,
	crj: 9,
	erj: 9,
	atr: 10,
	bizjet: 9,
	dc3: 11,
};

export const familyIconId = (family: string): string => `plane-${family}`;
export const familyNotableIconId = (family: string): string => `plane-notable-${family}`;

export const familyIconPx = (family: string): number =>
	FAMILY_ICON_PX[family as AircraftFamily] ?? PLANE_ICON_PX;

// Notables keep their 32px-class slot; only the shape's relative size varies.
export const familyNotableIconPx = (family: string): number =>
	Math.round((PLANE_NOTABLE_ICON_PX * familyIconPx(family)) / PLANE_ICON_PX);
