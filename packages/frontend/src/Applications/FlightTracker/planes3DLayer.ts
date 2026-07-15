import type { CustomLayerInterface, CustomRenderMethodInput, Map as MaplibreMap } from "maplibre-gl";
import { buildPlaneMesh } from "./plane3dMesh";

// True-3D aircraft rendering (issue #250). A MapLibre custom style layer that
// draws every airborne flight as an instanced, flat-shaded prism of the
// icon-derived silhouette — rotated by heading AND pitch, which fill-extrusion
// fundamentally cannot do (its tops are always horizontal; strip-banding
// rendered climbs as sliced staircases).
//
// Projection support comes from MapLibre's injected shader prelude:
// projectTileFor3D(mercXY01, elevation) handles mercator and globe alike;
// under mercator the elevation is in conformal mercator units, under globe
// (the GLOBE define) it is meters — the shader branches on the define.
// Programs are cached per shaderData.variantName as the docs prescribe.

const VERTEX_BODY = `
in vec3 a_pos;
in vec3 a_normal;
in vec4 i_data0; // mercX, mercY, elevExaggeratedMeters, mercUnitsPerMeter
in vec4 i_data1; // headingRad, pitchRad, halfSizeMeters, notableFlag

uniform vec3 u_color;
uniform vec3 u_color_notable;

out vec3 v_color;

const vec3 LIGHT = vec3(0.30151, 0.30151, 0.90453); // pre-normalized

void main() {
	float ch = cos(i_data1.x); float sh = sin(i_data1.x);
	float cp = cos(i_data1.y); float sp = sin(i_data1.y);
	vec3 p = a_pos * i_data1.z; // local meters (x lateral, y forward, z up)
	// Pitch about the lateral axis: nose up for positive pitch…
	p = vec3(p.x, p.y * cp - p.z * sp, p.y * sp + p.z * cp);
	// …then heading, clockwise from north, about the up axis.
	p = vec3(p.x * ch + p.y * sh, -p.x * sh + p.y * ch, p.z);
	vec3 n = a_normal;
	n = vec3(n.x, n.y * cp - n.z * sp, n.y * sp + n.z * cp);
	n = vec3(n.x * ch + n.y * sh, -n.x * sh + n.y * ch, n.z);
	// Local east/north meters → mercator world units (mercator y grows south).
	vec2 posMerc = i_data0.xy + vec2(p.x, -p.y) * i_data0.w;
	float elevMeters = i_data0.z + p.z;
#ifdef GLOBE
	gl_Position = projectTileFor3D(posMerc, elevMeters);
#else
	gl_Position = projectTileFor3D(posMerc, elevMeters * i_data0.w);
#endif
	float shade = 0.55 + 0.45 * max(dot(normalize(n), LIGHT), 0.0);
	v_color = mix(u_color, u_color_notable, i_data1.w) * shade;
}
`;

const FRAGMENT_SOURCE = `#version 300 es
precision mediump float;
in vec3 v_color;
out vec4 fragColor;
void main() {
	fragColor = vec4(v_color, 1.0);
}
`;

const A_POS = 0;
const A_NORMAL = 1;
const I_DATA0 = 2;
const I_DATA1 = 3;

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

export class Planes3DLayer implements CustomLayerInterface {
	id = "planes-3d-model";
	type = "custom" as const;
	renderingMode = "3d" as const;

	/** Draw gate — custom layers have no layout visibility. */
	visible = false;

	private map: MaplibreMap | null = null;
	private gl: WebGL2RenderingContext | null = null;
	private programs = new Map<string, ProgramInfo>();
	private meshBuffer: WebGLBuffer | null = null;
	private normalBuffer: WebGLBuffer | null = null;
	private instanceBuffer: WebGLBuffer | null = null;
	private meshVertexCount = 0;
	private instanceData: Float32Array = new Float32Array(0);
	instanceCount = 0;
	private instancesDirty = false;
	private color: [number, number, number] = [0.23, 0.23, 0.23];
	private colorNotable: [number, number, number] = [0.75, 0.13, 0.16];

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.map?.triggerRepaint();
	}

	setColors(pinHex: string, notableHex: string): void {
		this.color = hexToRgb01(pinHex);
		this.colorNotable = hexToRgb01(notableHex);
		this.map?.triggerRepaint();
	}

	/** New per-frame instance attributes (see plane3dMesh.buildPlaneInstances). */
	updateInstances(data: Float32Array, count: number): void {
		this.instanceData = data;
		this.instanceCount = count;
		this.instancesDirty = true;
	}

	onAdd(map: MaplibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
		this.map = map;
		// MapLibre 5 always creates a WebGL2 context; instancing is core there.
		this.gl = gl as WebGL2RenderingContext;
		const mesh = buildPlaneMesh();
		this.meshVertexCount = mesh.vertexCount;
		this.meshBuffer = this.gl.createBuffer();
		this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.meshBuffer);
		this.gl.bufferData(this.gl.ARRAY_BUFFER, mesh.positions, this.gl.STATIC_DRAW);
		this.normalBuffer = this.gl.createBuffer();
		this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.normalBuffer);
		this.gl.bufferData(this.gl.ARRAY_BUFFER, mesh.normals, this.gl.STATIC_DRAW);
		this.instanceBuffer = this.gl.createBuffer();
	}

	onRemove(): void {
		const gl = this.gl;
		if (gl) {
			for (const { program } of this.programs.values()) gl.deleteProgram(program);
			if (this.meshBuffer) gl.deleteBuffer(this.meshBuffer);
			if (this.normalBuffer) gl.deleteBuffer(this.normalBuffer);
			if (this.instanceBuffer) gl.deleteBuffer(this.instanceBuffer);
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
				console.warn("planes-3d shader compile failed:", gl.getShaderInfoLog(shader));
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
		gl.bindAttribLocation(program, A_POS, "a_pos");
		gl.bindAttribLocation(program, A_NORMAL, "a_normal");
		gl.bindAttribLocation(program, I_DATA0, "i_data0");
		gl.bindAttribLocation(program, I_DATA1, "i_data1");
		gl.linkProgram(program);
		gl.deleteShader(vs);
		gl.deleteShader(fs);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			console.warn("planes-3d program link failed:", gl.getProgramInfoLog(program));
			gl.deleteProgram(program);
			return null;
		}
		const uniforms: ProgramInfo["uniforms"] = {};
		for (const name of [...PROJECTION_UNIFORMS, "u_color", "u_color_notable"]) {
			uniforms[name] = gl.getUniformLocation(program, name);
		}
		const info = { program, uniforms };
		this.programs.set(key, info);
		return info;
	}

	render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput): void {
		const gl = this.gl;
		if (!gl || !this.visible || this.instanceCount === 0) return;
		const info = this.getProgram(args);
		if (!info) return;
		gl.useProgram(info.program);

		// MapLibre's projection uniforms (names fixed by the injected prelude);
		// the mercator variant may optimize some away → null locations skipped.
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
		if (u.u_color_notable) gl.uniform3f(u.u_color_notable, ...this.colorNotable);

		gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuffer);
		gl.enableVertexAttribArray(A_POS);
		gl.vertexAttribPointer(A_POS, 3, gl.FLOAT, false, 0, 0);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
		gl.enableVertexAttribArray(A_NORMAL);
		gl.vertexAttribPointer(A_NORMAL, 3, gl.FLOAT, false, 0, 0);

		gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
		if (this.instancesDirty) {
			gl.bufferData(gl.ARRAY_BUFFER, this.instanceData, gl.DYNAMIC_DRAW);
			this.instancesDirty = false;
		}
		gl.enableVertexAttribArray(I_DATA0);
		gl.vertexAttribPointer(I_DATA0, 4, gl.FLOAT, false, 32, 0);
		gl.vertexAttribDivisor(I_DATA0, 1);
		gl.enableVertexAttribArray(I_DATA1);
		gl.vertexAttribPointer(I_DATA1, 4, gl.FLOAT, false, 32, 16);
		gl.vertexAttribDivisor(I_DATA1, 1);

		// Both faces matter on a pitched prism; depth state comes from maplibre.
		gl.disable(gl.CULL_FACE);
		gl.drawArraysInstanced(gl.TRIANGLES, 0, this.meshVertexCount, this.instanceCount);

		// Leave no instanced state behind — maplibre's own layers share this
		// context and don't expect divisors on generic attribute slots.
		gl.vertexAttribDivisor(I_DATA0, 0);
		gl.vertexAttribDivisor(I_DATA1, 0);
		gl.disableVertexAttribArray(A_POS);
		gl.disableVertexAttribArray(A_NORMAL);
		gl.disableVertexAttribArray(I_DATA0);
		gl.disableVertexAttribArray(I_DATA1);
	}
}
