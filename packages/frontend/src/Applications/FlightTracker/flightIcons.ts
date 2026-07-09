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
