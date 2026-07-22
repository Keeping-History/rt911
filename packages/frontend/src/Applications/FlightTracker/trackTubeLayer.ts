import type { CustomLayerInterface, CustomRenderMethodInput, Map as MaplibreMap } from "maplibre-gl";
import type { TrackTube } from "./trackTube";

// Smooth 3D track rendering: draws the splined tube from trackTube.ts with
// per-VERTEX elevation — the thing fill-extrusion fundamentally cannot do
// (per-feature flat tops are why the curtain staircases). Mercator-only, like
// Planes3DLayer; the curtain remains the globe fallback. The tube radius is a
// uniform, so zoom-tracking thickness never rebuilds geometry.

const VERTEX_BODY = `
in vec4 a_center; // mercX, mercY, elevExaggeratedMeters, mercUnitsPerMeter
in vec4 a_offset; // ENU unit offset from the centerline (xyz, also the normal) + fade (w)
in vec3 a_color;  // per-vertex RGB (phase color); used only when u_useVertexColor=1

uniform float u_radius; // meters
uniform vec3 u_color;
uniform float u_useVertexColor; // 1 = a_color (phase-colored tube), 0 = u_color (ribbons)
uniform float u_shaded; // 1 = light by the offset normal (tube), 0 = flat (ribbon)

out vec3 v_color;
out float v_alpha;

const vec3 LIGHT = vec3(0.30151, 0.30151, 0.90453); // pre-normalized

void main() {
	// Local east/north meters → mercator world units (mercator y grows south).
	vec2 posMerc = a_center.xy + vec2(a_offset.x, -a_offset.y) * u_radius * a_center.w;
	float elevMeters = a_center.z + a_offset.z * u_radius;
#ifdef GLOBE
	gl_Position = projectTileFor3D(posMerc, elevMeters);
#else
	gl_Position = projectTileFor3D(posMerc, elevMeters * a_center.w);
#endif
	float shade = mix(1.0, 0.6 + 0.4 * max(dot(a_offset.xyz, LIGHT), 0.0), u_shaded);
	vec3 base = mix(u_color, a_color, u_useVertexColor);
	v_color = base * shade;
	v_alpha = a_offset.w;
}
`;

// Premultiplied alpha — what maplibre's blend state expects from custom
// layers. Opaque layers (u_opacity 1) are unchanged by it.
const FRAGMENT_SOURCE = `#version 300 es
precision mediump float;
uniform float u_opacity;
in vec3 v_color;
in float v_alpha;
out vec4 fragColor;
void main() {
	float a = u_opacity * v_alpha;
	fragColor = vec4(v_color * a, a);
}
`;

const A_CENTER = 0;
const A_OFFSET = 1;
const A_COLOR = 2;

function hexToRgb01(hex: string): [number, number, number] {
	const n = Number.parseInt(hex.replace("#", ""), 16);
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

interface ProgramInfo {
	program: WebGLProgram;
	uniforms: Record<string, WebGLUniformLocation | null>;
}

const PROJECTION_UNIFORMS = [
	"u_projection_matrix",
	"u_projection_fallback_matrix",
	"u_projection_tile_mercator_coords",
	"u_projection_clipping_plane",
	"u_projection_transition",
] as const;

export interface TrackTube3DLayerConfig {
	id?: string;
	opacity?: number;
	/** false = flat color (trail ribbons); true = lit by the offset normal (tube). */
	shaded?: boolean;
}

export class TrackTube3DLayer implements CustomLayerInterface {
	readonly id: string;
	type = "custom" as const;
	renderingMode = "3d" as const;
	readonly opacity: number;
	readonly shaded: boolean;

	constructor(config: TrackTube3DLayerConfig = {}) {
		this.id = config.id ?? "track-tube-3d";
		this.opacity = config.opacity ?? 1;
		this.shaded = config.shaded ?? true;
	}

	/** Draw gate — custom layers have no layout visibility. */
	visible = false;

	private map: MaplibreMap | null = null;
	private gl: WebGL2RenderingContext | null = null;
	private programs = new Map<string, ProgramInfo>();
	private centerBuffer: WebGLBuffer | null = null;
	private offsetBuffer: WebGLBuffer | null = null;
	private colorBuffer: WebGLBuffer | null = null;
	private centers: Float32Array = new Float32Array(0);
	private offsets: Float32Array = new Float32Array(0);
	private colors: Float32Array = new Float32Array(0);
	private hasVertexColor = false;
	vertexCount = 0;
	private geometryDirty = false;
	private color: [number, number, number] = [0.7, 0.13, 0.13];
	private radiusM = 500;

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.map?.triggerRepaint();
	}

	setColor(hex: string): void {
		this.color = hexToRgb01(hex);
		this.map?.triggerRepaint();
	}

	/** New tube geometry (selection/profile change); empty tube clears the track. */
	setGeometry(tube: TrackTube): void {
		this.centers = tube.centers;
		this.offsets = tube.offsets;
		this.colors = tube.colors ?? new Float32Array(0);
		this.hasVertexColor = (tube.colors?.length ?? 0) > 0;
		this.vertexCount = tube.vertexCount;
		this.geometryDirty = true;
		this.map?.triggerRepaint();
	}

	/** Zoom-tracked tube radius in meters — a uniform, so per-frame is free. */
	setRadius(radiusM: number): void {
		if (this.radiusM === radiusM) return;
		this.radiusM = radiusM;
		this.map?.triggerRepaint();
	}

	onAdd(map: MaplibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
		this.map = map;
		this.gl = gl as WebGL2RenderingContext;
		this.centerBuffer = this.gl.createBuffer();
		this.offsetBuffer = this.gl.createBuffer();
		this.colorBuffer = this.gl.createBuffer();
	}

	onRemove(): void {
		const gl = this.gl;
		if (gl) {
			for (const { program } of this.programs.values()) gl.deleteProgram(program);
			if (this.centerBuffer) gl.deleteBuffer(this.centerBuffer);
			if (this.offsetBuffer) gl.deleteBuffer(this.offsetBuffer);
			if (this.colorBuffer) gl.deleteBuffer(this.colorBuffer);
		}
		this.programs.clear();
		this.map = null;
		this.gl = null;
	}

	private getProgram(args: CustomRenderMethodInput): ProgramInfo | null {
		const gl = this.gl;
		if (!gl) return null;
		const key = args.shaderData.variantName;
		const cached = this.programs.get(key);
		if (cached) return cached;

		const vertexSource = `#version 300 es
${args.shaderData.vertexShaderPrelude}
${args.shaderData.define}
${VERTEX_BODY}`;
		const compile = (type: number, source: string): WebGLShader | null => {
			const shader = gl.createShader(type);
			if (!shader) return null;
			gl.shaderSource(shader, source);
			gl.compileShader(shader);
			if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
				console.warn("track-tube shader compile failed:", gl.getShaderInfoLog(shader));
				gl.deleteShader(shader);
				return null;
			}
			return shader;
		};
		const vs = compile(gl.VERTEX_SHADER, vertexSource);
		const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
		const program = gl.createProgram();
		if (!vs || !fs || !program) return null;
		gl.attachShader(program, vs);
		gl.attachShader(program, fs);
		gl.bindAttribLocation(program, A_CENTER, "a_center");
		gl.bindAttribLocation(program, A_OFFSET, "a_offset");
		gl.bindAttribLocation(program, A_COLOR, "a_color");
		gl.linkProgram(program);
		gl.deleteShader(vs);
		gl.deleteShader(fs);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			console.warn("track-tube program link failed:", gl.getProgramInfoLog(program));
			gl.deleteProgram(program);
			return null;
		}
		const uniforms: ProgramInfo["uniforms"] = {};
		for (const name of [
			...PROJECTION_UNIFORMS, "u_color", "u_radius", "u_opacity", "u_shaded", "u_useVertexColor",
		]) {
			uniforms[name] = gl.getUniformLocation(program, name);
		}
		const info = { program, uniforms };
		this.programs.set(key, info);
		return info;
	}

	render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput): void {
		const gl = this.gl;
		if (!gl || !this.visible || this.vertexCount === 0) return;
		const info = this.getProgram(args);
		if (!info) return;
		gl.useProgram(info.program);

		const pd = args.defaultProjectionData;
		const u = info.uniforms;
		if (u.u_projection_matrix)
			gl.uniformMatrix4fv(u.u_projection_matrix, false, pd.mainMatrix as Float32Array | number[]);
		if (u.u_projection_fallback_matrix)
			gl.uniformMatrix4fv(
				u.u_projection_fallback_matrix,
				false,
				pd.fallbackMatrix as Float32Array | number[],
			);
		if (u.u_projection_tile_mercator_coords)
			gl.uniform4f(u.u_projection_tile_mercator_coords, ...pd.tileMercatorCoords);
		if (u.u_projection_clipping_plane)
			gl.uniform4f(u.u_projection_clipping_plane, ...pd.clippingPlane);
		if (u.u_projection_transition)
			gl.uniform1f(u.u_projection_transition, pd.projectionTransition);
		if (u.u_color) gl.uniform3f(u.u_color, ...this.color);
		if (u.u_radius) gl.uniform1f(u.u_radius, this.radiusM);
		if (u.u_opacity) gl.uniform1f(u.u_opacity, this.opacity);
		if (u.u_shaded) gl.uniform1f(u.u_shaded, this.shaded ? 1 : 0);
		if (u.u_useVertexColor) gl.uniform1f(u.u_useVertexColor, this.hasVertexColor ? 1 : 0);

		gl.bindBuffer(gl.ARRAY_BUFFER, this.centerBuffer);
		if (this.geometryDirty) gl.bufferData(gl.ARRAY_BUFFER, this.centers, gl.DYNAMIC_DRAW);
		gl.enableVertexAttribArray(A_CENTER);
		gl.vertexAttribPointer(A_CENTER, 4, gl.FLOAT, false, 0, 0);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.offsetBuffer);
		if (this.geometryDirty) gl.bufferData(gl.ARRAY_BUFFER, this.offsets, gl.DYNAMIC_DRAW);
		gl.enableVertexAttribArray(A_OFFSET);
		gl.vertexAttribPointer(A_OFFSET, 4, gl.FLOAT, false, 0, 0);
		if (this.hasVertexColor) {
			gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
			if (this.geometryDirty) gl.bufferData(gl.ARRAY_BUFFER, this.colors, gl.DYNAMIC_DRAW);
			gl.enableVertexAttribArray(A_COLOR);
			gl.vertexAttribPointer(A_COLOR, 3, gl.FLOAT, false, 0, 0);
		}
		this.geometryDirty = false;

		// Premultiplied-alpha blending to match the fragment output; opaque
		// geometry (u_opacity 1) is unaffected.
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.disable(gl.CULL_FACE);
		gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);

		gl.disableVertexAttribArray(A_CENTER);
		gl.disableVertexAttribArray(A_OFFSET);
		if (this.hasVertexColor) gl.disableVertexAttribArray(A_COLOR);
	}
}
