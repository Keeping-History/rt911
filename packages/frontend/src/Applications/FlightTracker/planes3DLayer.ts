import type { CustomLayerInterface, CustomRenderMethodInput, Map as MaplibreMap } from "maplibre-gl";
import { type PlaneMesh, buildPlaneMesh } from "./plane3dMesh";

// True-3D instanced-mesh rendering (issues #250, #242). A MapLibre custom
// style layer that draws one flat-shaded mesh per instance — by default the
// icon-derived aircraft prism, rotated by heading AND pitch, which
// fill-extrusion fundamentally cannot do (its tops are always horizontal;
// strip-banding rendered climbs as sliced staircases). The same class also
// backs the loop-mode replay-trail layer with a sphere mesh (the extruded-disc pucks
// read as cylinders once the zoom-scaled radius passes a few pixels).
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
uniform vec3 u_color_observer;

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
	// Category flag: 0 = regular, 1 = notable, 2 = observer.
	vec3 base = i_data1.w < 0.5 ? u_color : (i_data1.w < 1.5 ? u_color_notable : u_color_observer);
	v_color = base * shade;
}
`;

// Premultiplied alpha — what maplibre's blend state expects from custom
// layers. Opaque layers (u_opacity 1) are unchanged by it.
const FRAGMENT_SOURCE = `#version 300 es
precision mediump float;
uniform float u_opacity;
in vec3 v_color;
out vec4 fragColor;
void main() {
	fragColor = vec4(v_color * u_opacity, u_opacity);
}
`;

// Radar-mode 8-bit pass: draw the meshes into a low-res offscreen buffer, then
// upscale it over the map with a NEAREST-sampled fullscreen triangle so the
// aircraft read as chunky pixels — the screen-space analog of the 2D icons'
// grid quantization. The triangle is generated from gl_VertexID (no attribute
// buffers), and v_uv maps the visible [-1,1] clip square onto [0,1] texcoords.
const BLIT_VERTEX = `#version 300 es
out vec2 v_uv;
void main() {
	vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
	v_uv = pos;
	gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}
`;
const BLIT_FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 fragColor;
void main() {
	fragColor = texture(u_tex, v_uv); // already premultiplied from the mesh pass
}
`;

// Device pixels per pixelated block. ~4 matches the 2D radar icons' grain
// (they quantize to ~2-4 device px/cell). One knob — bump for chunkier.
export const PIXEL_BLOCK_PX = 4;

/**
 * Low-res offscreen target size for a given drawing buffer and block size.
 * Rounds up so the whole canvas is covered, and clamps to 1×1 so a pre-layout
 * (0-sized) canvas never asks GL for a zero-dimension texture.
 */
export function pixelBufferSize(
	drawingBufferWidth: number,
	drawingBufferHeight: number,
	block: number,
): { width: number; height: number } {
	return {
		width: Math.max(1, Math.ceil(drawingBufferWidth / block)),
		height: Math.max(1, Math.ceil(drawingBufferHeight / block)),
	};
}

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

export interface Planes3DLayerConfig {
	id?: string;
	buildMesh?: () => PlaneMesh;
	opacity?: number;
}

export class Planes3DLayer implements CustomLayerInterface {
	readonly id: string;
	type = "custom" as const;
	renderingMode = "3d" as const;
	readonly opacity: number;
	private buildMesh: () => PlaneMesh;

	constructor(config: Planes3DLayerConfig = {}) {
		this.id = config.id ?? "planes-3d-model";
		this.buildMesh = config.buildMesh ?? buildPlaneMesh;
		this.opacity = config.opacity ?? 1;
	}

	/** Draw gate — custom layers have no layout visibility. */
	visible = false;

	private map: MaplibreMap | null = null;
	private gl: WebGL2RenderingContext | null = null;
	private programs = new Map<string, ProgramInfo>();
	// Mesh registry: "default" is the constructor's buildMesh(); more meshes
	// (per-airframe aircraft models, issue #250 follow-up) register at any
	// time and upload lazily once the GL context exists.
	private meshes = new Map<string, { pos: WebGLBuffer; nrm: WebGLBuffer; vertexCount: number }>();
	private pendingMeshes = new Map<string, PlaneMesh>();
	// Per-frame draw list: one instanced draw per batch; a batch whose mesh
	// key isn't registered (asset still loading) falls back to "default".
	private batches: {
		meshKey: string;
		data: Float32Array;
		count: number;
		buffer: WebGLBuffer | null;
		dirty: boolean;
	}[] = [];
	instanceCount = 0;
	private color: [number, number, number] = [0.23, 0.23, 0.23];
	private colorNotable: [number, number, number] = [0.75, 0.13, 0.16];
	private colorObserver: [number, number, number] = [0.06, 0.46, 0.43];

	/** Radar-mode 8-bit toggle. Off = today's direct-to-framebuffer path. */
	pixelate = false;
	// Offscreen target + blit program, allocated lazily on first pixelated
	// render and resized when the drawing buffer changes.
	private fbo: WebGLFramebuffer | null = null;
	private fboTex: WebGLTexture | null = null;
	private fboDepth: WebGLRenderbuffer | null = null;
	private fboW = 0;
	private fboH = 0;
	private blit: { program: WebGLProgram; uTex: WebGLUniformLocation | null } | null = null;

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.map?.triggerRepaint();
	}

	setPixelate(pixelate: boolean): void {
		if (this.pixelate === pixelate) return;
		this.pixelate = pixelate;
		this.map?.triggerRepaint();
	}

	setColors(pinHex: string, notableHex: string, observerHex?: string): void {
		this.color = hexToRgb01(pinHex);
		this.colorNotable = hexToRgb01(notableHex);
		if (observerHex) this.colorObserver = hexToRgb01(observerHex);
		this.map?.triggerRepaint();
	}

	/** Single-batch sugar (the sphere replay-trail layer's whole API). */
	updateInstances(data: Float32Array, count: number): void {
		this.updateBatches([{ meshKey: "default", data, count }]);
	}

	/** Per-frame draw list, one entry per mesh (aircraft family). */
	updateBatches(next: { meshKey: string; data: Float32Array; count: number }[]): void {
		// Reuse GL buffers positionally; grow/shrink the list as needed.
		for (let i = 0; i < next.length; i++) {
			const existing = this.batches[i];
			if (existing) {
				existing.meshKey = next[i].meshKey;
				existing.data = next[i].data;
				existing.count = next[i].count;
				existing.dirty = true;
			} else {
				this.batches.push({ ...next[i], buffer: null, dirty: true });
			}
		}
		for (const dropped of this.batches.splice(next.length)) {
			if (dropped.buffer && this.gl) this.gl.deleteBuffer(dropped.buffer);
		}
		this.instanceCount = next.reduce((sum, b) => sum + b.count, 0);
	}

	/** Register an additional mesh (uploads now, or at onAdd if pre-GL). */
	registerMesh(key: string, mesh: PlaneMesh): void {
		if (this.gl) this.uploadMesh(key, mesh);
		else this.pendingMeshes.set(key, mesh);
		this.map?.triggerRepaint();
	}

	hasMesh(key: string): boolean {
		return this.meshes.has(key) || this.pendingMeshes.has(key);
	}

	private uploadMesh(key: string, mesh: PlaneMesh): void {
		const gl = this.gl;
		if (!gl) return;
		const old = this.meshes.get(key);
		if (old) {
			gl.deleteBuffer(old.pos);
			gl.deleteBuffer(old.nrm);
		}
		const pos = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, pos);
		gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
		const nrm = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, nrm);
		gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
		if (pos && nrm) this.meshes.set(key, { pos, nrm, vertexCount: mesh.vertexCount });
	}

	onAdd(map: MaplibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
		this.map = map;
		// MapLibre 5 always creates a WebGL2 context; instancing is core there.
		this.gl = gl as WebGL2RenderingContext;
		this.uploadMesh("default", this.buildMesh());
		for (const [key, mesh] of this.pendingMeshes) this.uploadMesh(key, mesh);
		this.pendingMeshes.clear();
	}

	onRemove(): void {
		const gl = this.gl;
		if (gl) {
			for (const { program } of this.programs.values()) gl.deleteProgram(program);
			for (const { pos, nrm } of this.meshes.values()) {
				gl.deleteBuffer(pos);
				gl.deleteBuffer(nrm);
			}
			for (const b of this.batches) if (b.buffer) gl.deleteBuffer(b.buffer);
			if (this.blit) gl.deleteProgram(this.blit.program);
			if (this.fbo) gl.deleteFramebuffer(this.fbo);
			if (this.fboTex) gl.deleteTexture(this.fboTex);
			if (this.fboDepth) gl.deleteRenderbuffer(this.fboDepth);
		}
		this.programs.clear();
		this.meshes.clear();
		this.batches = [];
		this.blit = null;
		this.fbo = this.fboTex = this.fboDepth = null;
		this.fboW = this.fboH = 0;
		this.map = null;
		this.gl = null;
	}

	// Allocate (or resize) the low-res color+depth target and compile the blit
	// program. Returns false on any GL failure so render() falls back to the
	// direct path instead of throwing into maplibre.
	private setupPixelTargets(gl: WebGL2RenderingContext): boolean {
		const { width, height } = pixelBufferSize(
			gl.drawingBufferWidth,
			gl.drawingBufferHeight,
			PIXEL_BLOCK_PX,
		);
		if (!this.blit) {
			const compile = (type: number, src: string): WebGLShader | null => {
				const s = gl.createShader(type);
				if (!s) return null;
				gl.shaderSource(s, src);
				gl.compileShader(s);
				if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
					console.warn("planes-3d blit compile failed:", gl.getShaderInfoLog(s));
					gl.deleteShader(s);
					return null;
				}
				return s;
			};
			const vs = compile(gl.VERTEX_SHADER, BLIT_VERTEX);
			const fs = compile(gl.FRAGMENT_SHADER, BLIT_FRAGMENT);
			const program = gl.createProgram();
			if (!vs || !fs || !program) return false;
			gl.attachShader(program, vs);
			gl.attachShader(program, fs);
			gl.linkProgram(program);
			gl.deleteShader(vs);
			gl.deleteShader(fs);
			if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
				console.warn("planes-3d blit link failed:", gl.getProgramInfoLog(program));
				gl.deleteProgram(program);
				return false;
			}
			this.blit = { program, uTex: gl.getUniformLocation(program, "u_tex") };
		}
		if (!this.fbo) {
			this.fbo = gl.createFramebuffer();
			this.fboTex = gl.createTexture();
			this.fboDepth = gl.createRenderbuffer();
		}
		if (!this.fbo || !this.fboTex || !this.fboDepth) return false;
		if (width !== this.fboW || height !== this.fboH) {
			gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
			// NEAREST both ways is the whole point — hard blocks, no smoothing.
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			gl.bindRenderbuffer(gl.RENDERBUFFER, this.fboDepth);
			gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);
			gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
			gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
			gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.fboDepth);
			gl.bindTexture(gl.TEXTURE_2D, null);
			gl.bindRenderbuffer(gl.RENDERBUFFER, null);
			this.fboW = width;
			this.fboH = height;
		}
		return true;
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
		for (const name of [...PROJECTION_UNIFORMS, "u_color", "u_color_notable", "u_color_observer", "u_opacity"]) {
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

		// Radar 8-bit path: draw the meshes into the low-res target, then upscale
		// it over the map with NEAREST. Its own depth buffer preserves plane↔plane
		// occlusion; occlusion against the basemap is intentionally dropped (a
		// radar scope shows every contact, and radar mode uses flat hillshade, not
		// 3D terrain geometry). Any GL setup failure falls back to the direct draw.
		if (this.pixelate) {
			// Capture maplibre's framebuffer + viewport BEFORE touching any GL
			// target: setupPixelTargets binds our own fbo when it (re)allocates,
			// so reading the binding after it would capture ours and the blit
			// would then draw into the texture it samples — a feedback loop.
			const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
			const vp = gl.getParameter(gl.VIEWPORT) as Int32Array;
			if (this.setupPixelTargets(gl)) {
				gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
				gl.viewport(0, 0, this.fboW, this.fboH);
				gl.enable(gl.DEPTH_TEST);
				gl.depthFunc(gl.LEQUAL);
				gl.depthMask(true);
				gl.clearColor(0, 0, 0, 0);
				gl.clearDepth(1);
				gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
				this.drawBatches(gl, info, args);
				gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
				gl.viewport(vp[0], vp[1], vp[2], vp[3]);
				this.blitPixels(gl);
				return;
			}
		}
		this.drawBatches(gl, info, args);
	}

	// Composite the low-res target over maplibre's framebuffer with a
	// NEAREST-sampled fullscreen triangle. Premultiplied-over blend matches the
	// mesh fragment output; depth writes are masked off so maplibre's own depth
	// buffer is untouched, and standard 3D depth state is restored afterward.
	private blitPixels(gl: WebGL2RenderingContext): void {
		const b = this.blit;
		if (!b || !this.fboTex) return;
		gl.useProgram(b.program);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
		if (b.uTex) gl.uniform1i(b.uTex, 0);
		gl.disable(gl.DEPTH_TEST);
		gl.depthMask(false);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.bindTexture(gl.TEXTURE_2D, null);
		gl.enable(gl.DEPTH_TEST);
		gl.depthMask(true);
	}

	private drawBatches(
		gl: WebGL2RenderingContext,
		info: ProgramInfo,
		args: CustomRenderMethodInput,
	): void {
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
		if (u.u_color_observer) gl.uniform3f(u.u_color_observer, ...this.colorObserver);
		if (u.u_opacity) gl.uniform1f(u.u_opacity, this.opacity);

		gl.enableVertexAttribArray(A_POS);
		gl.enableVertexAttribArray(A_NORMAL);
		gl.enableVertexAttribArray(I_DATA0);
		gl.enableVertexAttribArray(I_DATA1);
		gl.vertexAttribDivisor(I_DATA0, 1);
		gl.vertexAttribDivisor(I_DATA1, 1);

		// Both faces matter on a pitched prism; depth state comes from maplibre.
		// Blending must be premultiplied-alpha to match the fragment output —
		// translucent layers (replay trails) depend on it, opaque ones are unaffected.
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.disable(gl.CULL_FACE);

		for (const batch of this.batches) {
			if (batch.count === 0) continue;
			const mesh = this.meshes.get(batch.meshKey) ?? this.meshes.get("default");
			if (!mesh) continue;
			gl.bindBuffer(gl.ARRAY_BUFFER, mesh.pos);
			gl.vertexAttribPointer(A_POS, 3, gl.FLOAT, false, 0, 0);
			gl.bindBuffer(gl.ARRAY_BUFFER, mesh.nrm);
			gl.vertexAttribPointer(A_NORMAL, 3, gl.FLOAT, false, 0, 0);
			if (!batch.buffer) batch.buffer = gl.createBuffer();
			gl.bindBuffer(gl.ARRAY_BUFFER, batch.buffer);
			if (batch.dirty) {
				gl.bufferData(gl.ARRAY_BUFFER, batch.data, gl.DYNAMIC_DRAW);
				batch.dirty = false;
			}
			gl.vertexAttribPointer(I_DATA0, 4, gl.FLOAT, false, 32, 0);
			gl.vertexAttribPointer(I_DATA1, 4, gl.FLOAT, false, 32, 16);
			gl.drawArraysInstanced(gl.TRIANGLES, 0, mesh.vertexCount, batch.count);
		}

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
