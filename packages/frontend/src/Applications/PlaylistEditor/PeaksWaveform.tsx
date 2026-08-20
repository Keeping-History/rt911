/**
 * PeaksWaveform moved to radio-core when the Radio Traffic cards started
 * drawing the same envelope the timeline's radio lane draws. This re-export
 * keeps the timeline's call sites (LanePreview.tsx, alongside usePeaksForSpan)
 * pointing at the path they always used; apps depend on radio-core, never the
 * reverse.
 */
export { PeaksWaveform } from "../radio-core/PeaksWaveform";
