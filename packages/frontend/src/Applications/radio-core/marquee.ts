import MarqueeImport from "react-fast-marquee";

// react-fast-marquee ships CJS-only (main: dist/index.js, no exports map, no
// ESM build). Vite 8's rolldown dep optimizer re-exports the raw CJS
// namespace as the default export ({ __esModule, default: Marquee }), so a
// plain default import reaches React as an object and crashes with
// "Element type is invalid ... got: object". Unwrap defensively — this works
// under every interop shape (vite dev, vite build, vitest).
const Marquee = ((MarqueeImport as unknown as { default?: typeof MarqueeImport })
	.default ?? MarqueeImport) as typeof MarqueeImport;

export default Marquee;
