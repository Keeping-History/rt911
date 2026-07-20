import type { AircraftFamily } from "./aircraftModels";

// Plane icon pipeline: MapLibre symbol layers consume pre-registered raster
// images, not SVGs, and non-SDF icons can't be recolored via paint. So the
// pin colors are baked in here: inject the fill into the SVG string,
// rasterize, and (re)install the image on the map when a color changes.
export const PLANE_ICON_ID = "plane-icon";
export const PLANE_NOTABLE_ICON_ID = "plane-notable-icon";
// Observer aircraft (GOFER06) share the notable treatment/size in their own
// color — see notableFlights.isObserver.
export const PLANE_OBSERVER_ICON_ID = "plane-observer-icon";
export const PLANE_ICON_PX = 12; // display size; rasterized at 2× (pixelRatio 2)
export const PLANE_NOTABLE_ICON_PX = 32;

// The art (a single path with no fill of its own) inherits the root fill.
export const colorizeSvg = (svg: string, fill: string): string =>
	svg.replace("<svg ", `<svg fill="${fill}" `);

// --- 8-bit ("radar" map style) variant -------------------------------------
// Radar mode renders the same silhouettes as chunky pixel art. The art is
// vector, so this is a resample, not a blow-up of an already-small bitmap:
// rasterize the SVG down onto a coarse grid, hard-edge the alpha, then scale
// back up with nearest-neighbour. Only the bitmap changes — the symbol layers,
// icon ids and sizes are identical, so nothing downstream knows about it.

// Sprite resolution. Proportional so a 32px notable gets more blocks than a
// 9px regional jet, clamped to the 8-16 band: below 8 the silhouette stops
// being recognisable, above 16 the blocks are too fine to read as pixel art.
export const PIXEL_GRID_MIN = 8;
export const PIXEL_GRID_MAX = 16;
export const pixelGrid = (displayPx: number): number =>
	Math.min(PIXEL_GRID_MAX, Math.max(PIXEL_GRID_MIN, Math.round(displayPx * 0.75)));

// Downsampling antialiases, leaving soft gray edges that read as "blurry",
// not "8-bit". Snapping alpha to 0/255 restores hard pixel edges. Deliberately
// below the half-covered 128 midpoint: a wingtip that only partly fills its
// cell should survive, or wide-bodies lose their wings entirely.
export const PIXEL_ALPHA_THRESHOLD = 96;

export const snapAlpha = (data: Uint8ClampedArray, threshold: number): void => {
	// RGB is left alone: getImageData is non-premultiplied, so a partly
	// transparent pixel already carries the full-strength pin color.
	for (let i = 3; i < data.length; i += 4) {
		data[i] = data[i] >= threshold ? 255 : 0;
	}
};

const makeCanvas = (size: number): [HTMLCanvasElement, CanvasRenderingContext2D] => {
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("2d canvas unavailable");
	return [canvas, ctx];
};

export const buildPlaneImage = (
	svg: string,
	fill: string,
	displayPx: number,
	pixelate = false,
): Promise<ImageData> =>
	new Promise((resolve, reject) => {
		const px = displayPx * 2;
		const img = new Image();
		img.onload = () => {
			try {
				const [, ctx] = makeCanvas(px);
				if (!pixelate) {
					ctx.drawImage(img, 0, 0, px, px);
					resolve(ctx.getImageData(0, 0, px, px));
					return;
				}
				// Rasterize onto the coarse grid on its own canvas — drawing a
				// canvas onto an overlapping region of itself is not reliable.
				const grid = pixelGrid(displayPx);
				const [gridCanvas, gridCtx] = makeCanvas(grid);
				gridCtx.drawImage(img, 0, 0, grid, grid);
				const cells = gridCtx.getImageData(0, 0, grid, grid);
				snapAlpha(cells.data, PIXEL_ALPHA_THRESHOLD);
				gridCtx.putImageData(cells, 0, 0);
				// Nearest-neighbour back up to the real icon size.
				ctx.imageSmoothingEnabled = false;
				ctx.drawImage(gridCanvas, 0, 0, px, px);
				resolve(ctx.getImageData(0, 0, px, px));
			} catch (err) {
				reject(err);
			}
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
export const familyObserverIconId = (family: string): string => `plane-observer-${family}`;

export const familyIconPx = (family: string): number =>
	FAMILY_ICON_PX[family as AircraftFamily] ?? PLANE_ICON_PX;

// Notables (and observers, which share the slot) keep their 32px-class size;
// only the shape's relative size varies.
export const familyNotableIconPx = (family: string): number =>
	Math.round((PLANE_NOTABLE_ICON_PX * familyIconPx(family)) / PLANE_ICON_PX);
