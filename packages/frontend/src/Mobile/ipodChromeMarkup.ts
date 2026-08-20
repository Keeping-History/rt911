// packages/frontend/src/Mobile/ipodChromeMarkup.ts
// Verbatim DoodleDev-exported SVG blocks from robbiebyrd/ipod_ui
// js/components/IpodDesign.js (MIT — see VENDORED.md). Kept as raw HTML
// strings and injected with dangerouslySetInnerHTML: the filter/gradient
// attribute soup does not survive hand-conversion to JSX.

/** The <svg id="doodle-defs">…</svg> block (shared gradients + filters). */
export const SHELL_DEFS_SVG = `  <svg id="doodle-defs" aria-hidden="true" width="0" height="0"
    style="height: 1px; left: -100px; opacity: 0; overflow-x: hidden; overflow-y: hidden; pointer-events: none; position: fixed; top: -100px; width: 1px">
    <defs>
      <linearGradient id="shared-fill-1" x1="31.27%" y1="3.64%" x2="68.73%" y2="96.36%">
        <stop offset="0%" stop-color="#f2f2f2"></stop>
        <stop offset="99%" stop-color="#808080"></stop>
      </linearGradient>
      <linearGradient id="shared-stroke-4" x1="50%" y1="0%" x2="50%" y2="100%">
        <stop offset="0%" stop-color="#282828"></stop>
        <stop offset="100%" stop-color="#202020"></stop>
      </linearGradient>
      <linearGradient id="shared-stroke-8" x1="50%" y1="0%" x2="50%" y2="100%">
        <stop offset="0%" stop-color="#828282"></stop>
        <stop offset="100%" stop-color="#737373"></stop>
      </linearGradient>
      <linearGradient id="wheel-rock-next" x1="0%" y1="50%" x2="100%" y2="50%">
        <stop offset="0%" stop-color="#828282"></stop>
        <stop offset="100%" stop-color="#404040"></stop>
      </linearGradient>
      <linearGradient id="wheel-rock-prev" x1="100%" y1="50%" x2="0%" y2="50%">
        <stop offset="0%" stop-color="#828282"></stop>
        <stop offset="100%" stop-color="#404040"></stop>
      </linearGradient>
      <linearGradient id="wheel-rock-menu" x1="50%" y1="100%" x2="50%" y2="0%">
        <stop offset="0%" stop-color="#828282"></stop>
        <stop offset="100%" stop-color="#404040"></stop>
      </linearGradient>
      <linearGradient id="wheel-rock-play" x1="50%" y1="0%" x2="50%" y2="100%">
        <stop offset="0%" stop-color="#828282"></stop>
        <stop offset="100%" stop-color="#404040"></stop>
      </linearGradient>
      <linearGradient id="mid-rock-next" x1="0%" y1="50%" x2="100%" y2="50%">
        <stop offset="0%" stop-color="#f0f0f0"></stop>
        <stop offset="100%" stop-color="#606060"></stop>
      </linearGradient>
      <linearGradient id="mid-rock-prev" x1="100%" y1="50%" x2="0%" y2="50%">
        <stop offset="0%" stop-color="#f0f0f0"></stop>
        <stop offset="100%" stop-color="#606060"></stop>
      </linearGradient>
      <linearGradient id="mid-rock-menu" x1="50%" y1="100%" x2="50%" y2="0%">
        <stop offset="0%" stop-color="#f0f0f0"></stop>
        <stop offset="100%" stop-color="#606060"></stop>
      </linearGradient>
      <linearGradient id="mid-rock-play" x1="50%" y1="0%" x2="50%" y2="100%">
        <stop offset="0%" stop-color="#f0f0f0"></stop>
        <stop offset="100%" stop-color="#606060"></stop>
      </linearGradient>
      <linearGradient id="shared-fill-10" x1="50%" y1="0%" x2="50%" y2="100%">
        <stop offset="0%" stop-color="#959595"></stop>
        <stop offset="100%" stop-color="#d4d6d7"></stop>
      </linearGradient>
      <linearGradient id="shared-stroke-11" x1="50%" y1="0%" x2="50%" y2="100%">
        <stop offset="0%" stop-color="#f0f0f0"></stop>
        <stop offset="100%" stop-color="#919191"></stop>
      </linearGradient>
      <filter id="shared-inner-2" primitiveunits="objectBoundingBox" x="-50%" y="-50%" width="200%" height="200%">
        <feFlood flood-color="black" flood-opacity="1.00" result="flood"></feFlood>
        <feComposite operator="out" in="flood" in2="SourceAlpha" result="inv"></feComposite>
        <feGaussianBlur stdDeviation="0.05" in="inv"></feGaussianBlur>
        <feComposite operator="in" in2="SourceAlpha" result="sh"></feComposite>
        <feMerge>
          <feMergeNode in="SourceGraphic"></feMergeNode>
          <feMergeNode in="sh"></feMergeNode>
          <feMergeNode in="sh"></feMergeNode>
        </feMerge>
      </filter>
      <filter id="shared-outer-3" filterunits="userSpaceOnUse" x="-38" y="-38" width="447" height="699">
        <feMorphology operator="dilate" radius="5.00" in="SourceAlpha" result="s_spread"></feMorphology>
        <feGaussianBlur in="s_spread" stdDeviation="10.00" result="s_blur"></feGaussianBlur>
        <feOffset in="s_blur" dx="0.00" dy="0.00" result="s_offset"></feOffset>
        <feFlood flood-color="black" flood-opacity="0.27" result="s_color"></feFlood>
        <feComposite in="s_color" in2="s_offset" operator="in" result="shadow_out"></feComposite>
        <feMerge>
          <feMergeNode in="shadow_out"></feMergeNode>
          <feMergeNode in="SourceGraphic"></feMergeNode>
        </feMerge>
      </filter>
      <filter id="shared-inner-5" primitiveunits="objectBoundingBox" x="-50%" y="-50%" width="200%" height="200%">
        <feFlood flood-color="black" flood-opacity="1.00" result="df"></feFlood>
        <feComposite operator="out" in2="SourceAlpha" in="df" result="di"></feComposite>
        <feOffset dx="0.0052" dy="-0.0033" in="di" result="do"></feOffset>
        <feGaussianBlur stdDeviation="0.0128" in="do" result="db"></feGaussianBlur>
        <feComposite operator="in" in2="SourceAlpha" in="db" result="sh"></feComposite>
        <feFlood flood-color="white" flood-opacity="0.14" result="lf"></feFlood>
        <feComposite operator="out" in2="SourceAlpha" in="lf" result="li"></feComposite>
        <feOffset dx="-0.0052" dy="0.0033" in="li" result="lo"></feOffset>
        <feGaussianBlur stdDeviation="0.0128" in="lo" result="lb"></feGaussianBlur>
        <feComposite operator="in" in2="SourceAlpha" in="lb" result="gl"></feComposite>
        <feMerge>
          <feMergeNode in="SourceGraphic"></feMergeNode>
          <feMergeNode in="gl"></feMergeNode>
          <feMergeNode in="sh"></feMergeNode>
        </feMerge>
      </filter>
      <filter id="shared-inner-9" primitiveunits="objectBoundingBox" x="-50%" y="-50%" width="200%" height="200%">
        <feFlood flood-color="black" flood-opacity="1.00" result="flood"></feFlood>
        <feComposite operator="out" in="flood" in2="SourceAlpha" result="inv"></feComposite>
        <feGaussianBlur stdDeviation="0.0085" in="inv"></feGaussianBlur>
        <feComposite operator="in" in2="SourceAlpha" result="sh"></feComposite>
        <feMerge>
          <feMergeNode in="SourceGraphic"></feMergeNode>
          <feMergeNode in="sh"></feMergeNode>
        </feMerge>
      </filter>
      <filter id="shared-inner-12" primitiveunits="objectBoundingBox" x="-50%" y="-50%" width="200%" height="200%">
        <feFlood flood-color="black" flood-opacity="0.25" result="flood"></feFlood>
        <feComposite operator="out" in="flood" in2="SourceAlpha" result="inv"></feComposite>
        <feGaussianBlur stdDeviation="0.015" in="inv"></feGaussianBlur>
        <feComposite operator="in" in2="SourceAlpha" result="sh"></feComposite>
        <feMerge>
          <feMergeNode in="SourceGraphic"></feMergeNode>
          <feMergeNode in="sh"></feMergeNode>
        </feMerge>
      </filter>
    </defs>
  </svg>`;

/** The <div class="item" id="base">…</div> block (aluminium body). */
export const BASE_HTML = `    <div class="item" id="base" style="height: 100%; left: 0%; opacity: 1; top: 0%; width: 100%; z-index: 2">
      <svg class="shape" viewBox="0 0 371.000000 623.000000" width="371.000000" height="623.000000" preserveAspectRatio="none" style="overflow-x: visible; overflow-y: visible">
        <g filter="url(#shared-outer-3)">
          <path class="fill-path" d="M 36 0 L 335 0 A 36 36 0 0 1 371 36 L 371 587 A 36 36 0 0 1 335 623 L 36 623 A 36 36 0 0 1 0 587 L 0 36 A 36 36 0 0 1 36 0 Z" fill="url(#shared-fill-1)" vector-effect="non-scaling-stroke" filter="url(#shared-inner-2)"></path>
        </g>
      </svg>
    </div>`;

/** The <svg class="shape" viewBox="0 0 311.000000 234.000000">…</svg> inside
 *  #screen (dark bezel + border) — the svg element ONLY, not
 *  #ipod-screen-content. IpodDesign.js lines 133–141. */
export const SCREEN_BEZEL_SVG = `        <svg class="shape" viewBox="0 0 311.000000 234.000000" width="311.000000" height="234.000000" preserveAspectRatio="none">
          <defs>
            <path d="M 6 0 L 305 0 A 6 6 0 0 1 311 6 L 311 228 A 6 6 0 0 1 305 234 L 6 234 A 6 6 0 0 1 0 228 L 0 6 A 6 6 0 0 1 6 0 Z" id="path-3"></path>
          </defs>
          <g>
            <use class="fill-path" href="#path-3" fill="#2D2E2B" filter="url(#shared-inner-5)"></use>
            <use class="stroke-path" href="#path-3" fill="none" stroke="url(#shared-stroke-4)" stroke-width="3"></use>
          </g>
        </svg>`;

/** The <div class="item interactive" id="wheel">…</div> block (wheel ring).
 *  IpodDesign.js lines 185–195. */
export const WHEEL_RING_HTML = `      <div class="item interactive" id="wheel" style="height: 100%; left: 0%; top: 0%; width: 100%; z-index: 2">
        <svg class="shape" viewBox="0 0 236 236" preserveAspectRatio="none" width="236" height="236">
          <defs>
            <path d="M 0 118 C 0 52.829 52.829 0 118 0 C 183.171 0 236 52.829 236 118 C 236 183.171 183.171 236 118 236 C 52.829 236 0 183.171 0 118 Z M 76.7 118 C 76.7 140.81 95.19 159.3 118 159.3 C 140.81 159.3 159.3 140.81 159.3 118 C 159.3 95.19 140.81 76.7 118 76.7 C 95.19 76.7 76.7 95.19 76.7 118 Z" id="path-6"></path>
          </defs>
          <g>
            <use class="fill-path" href="#path-6" fill="#FFFFFF" filter="url(#shared-inner-9)"></use>
            <use class="stroke-path" href="#path-6" fill="none" stroke="url(#shared-stroke-8)" stroke-width="1"></use>
          </g>
        </svg>
      </div>`;

/** The <svg class="shape" viewBox="0 0 98.000000 98.000000">…</svg> inside
 *  #mid-button — the svg element ONLY. IpodDesign.js lines 197–204. */
export const MID_BUTTON_SVG = `        <svg class="shape" viewBox="0 0 98.000000 98.000000" width="98.000000" height="98.000000" preserveAspectRatio="none">
          <defs>
            <path d="M 49 0 L 49 0 A 49 49 0 0 1 98 49 L 98 49 A 49 49 0 0 1 49 98 L 49 98 A 49 49 0 0 1 0 49 L 0 49 A 49 49 0 0 1 49 0 Z" id="path-7"></path>
          </defs>
          <g>
            <use class="fill-path" href="#path-7" fill="url(#shared-fill-10)" filter="url(#shared-inner-12)"></use>
          </g>
        </svg>`;
