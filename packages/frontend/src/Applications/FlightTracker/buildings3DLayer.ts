import type { CustomLayerInterface, CustomRenderMethodInput, Map as MaplibreMap } from "maplibre-gl";
import type { BuildingMesh } from "./buildingMesh";

// Static 2001-buildings layer. Unlike planes3DLayer.ts (per-frame instanced
// aircraft), the skyline is baked once: each vertex already carries its world
// position (mercX, mercY, elevMeters, mercPerMeter) and an (east, north, up)
// normal, so the shader is a plain projected draw with flat directional shading.
// Projection support comes from MapLibre's injected prelude: projectTileFor3D
// handles mercator and globe alike, branching on the GLOBE define (meters under
// globe, mercator units under mercator — hence the pos.w scale on that branch).

const VERTEX_BODY = `
in vec4 a_pos;    // mercX, mercY, elevMeters, mercPerMeter
in vec3 a_normal; // east, north, up
uniform vec3 u_color;
out vec3 v_color;
const vec3 LIGHT = vec3(0.30151, 0.30151, 0.90453); // pre-normalized, up-biased
void main() {
	vec2 posMerc = a_pos.xy;
#ifdef GLOBE
	gl_Position = projectTileFor3D(posMerc, a_pos.z);
#else
	gl_Position = projectTileFor3D(posMerc, a_pos.z * a_pos.w);
#endif
	float shade = 0.55 + 0.45 * max(dot(normalize(a_normal), LIGHT), 0.0);
	v_color = u_color * shade;
}
`;

const FRAGMENT_SOURCE = `#version 300 es
precision mediump float;
in vec3 v_color;
out vec4 fragColor;
void main() { fragColor = vec4(v_color, 1.0); }
`;

const A_POS = 0;
const A_NORMAL = 1;

const PROJECTION_UNIFORMS = [
	"u_projection_matrix",
	"u_projection_fallback_matrix",
	"u_projection_tile_mercator_coords",
	"u_projection_clipping_plane",
	"u_projection_transition",
] as const;

interface ProgramInfo {
	program: WebGLProgram;
	uniforms: Record<string, WebGLUniformLocation | null>;
}

interface GpuMesh {
	pos: WebGLBuffer;
	nrm: WebGLBuffer;
	vertexCount: number;
}

export interface Buildings3DLayerConfig {
	id?: string;
}

export class Buildings3DLayer implements CustomLayerInterface {
	readonly id: string;
	type = "custom" as const;
	renderingMode = "3d" as const;
	visible = false;

	private map: MaplibreMap | null = null;
	private gl: WebGL2RenderingContext | null = null;
	private programs = new Map<string, ProgramInfo>();
	private meshes = new Map<string, GpuMesh>();
	private pending = new Map<string, BuildingMesh>();
	private color: [number, number, number] = [0.62, 0.62, 0.64];
	private heroColor: [number, number, number] = [0.78, 0.74, 0.68];
	private heroKeys = new Set<string>();

	constructor(config: Buildings3DLayerConfig = {}) {
		this.id = config.id ?? "buildings-3d";
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.map?.triggerRepaint();
	}

	setColor(rgb: [number, number, number]): void {
		this.color = rgb;
		this.map?.triggerRepaint();
	}

	setHeroColor(rgb: [number, number, number]): void {
		this.heroColor = rgb;
		this.map?.triggerRepaint();
	}

	markHero(key: string): void {
		this.heroKeys.add(key);
		this.map?.triggerRepaint();
	}

	setMesh(key: string, mesh: BuildingMesh): void {
		if (this.gl) this.uploadMesh(key, mesh);
		else this.pending.set(key, mesh);
		this.map?.triggerRepaint();
	}

	hasMesh(key: string): boolean {
		return this.meshes.has(key) || this.pending.has(key);
	}

	private uploadMesh(key: string, mesh: BuildingMesh): void {
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
		this.gl = gl as WebGL2RenderingContext;
		for (const [key, mesh] of this.pending) this.uploadMesh(key, mesh);
		this.pending.clear();
	}

	onRemove(): void {
		const gl = this.gl;
		if (gl) {
			for (const { program } of this.programs.values()) gl.deleteProgram(program);
			for (const { pos, nrm } of this.meshes.values()) {
				gl.deleteBuffer(pos);
				gl.deleteBuffer(nrm);
			}
		}
		this.programs.clear();
		this.meshes.clear();
		this.heroKeys.clear();
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
				console.warn("buildings-3d shader compile failed:", gl.getShaderInfoLog(shader));
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
		gl.linkProgram(program);
		gl.deleteShader(vs);
		gl.deleteShader(fs);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			console.warn("buildings-3d program link failed:", gl.getProgramInfoLog(program));
			gl.deleteProgram(program);
			return null;
		}
		const uniforms: ProgramInfo["uniforms"] = {};
		for (const name of [...PROJECTION_UNIFORMS, "u_color"]) {
			uniforms[name] = gl.getUniformLocation(program, name);
		}
		const info = { program, uniforms };
		this.programs.set(key, info);
		return info;
	}

	render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput): void {
		const gl = this.gl;
		if (!gl || !this.visible || this.meshes.size === 0) return;
		const info = this.getProgram(args);
		if (!info) return;
		gl.useProgram(info.program);

		const pd = args.defaultProjectionData;
		const u = info.uniforms;
		if (u.u_projection_matrix)
			gl.uniformMatrix4fv(u.u_projection_matrix, false, pd.mainMatrix as Float32Array | number[]);
		if (u.u_projection_fallback_matrix)
			gl.uniformMatrix4fv(u.u_projection_fallback_matrix, false, pd.fallbackMatrix as Float32Array | number[]);
		if (u.u_projection_tile_mercator_coords)
			gl.uniform4f(u.u_projection_tile_mercator_coords, ...pd.tileMercatorCoords);
		if (u.u_projection_clipping_plane)
			gl.uniform4f(u.u_projection_clipping_plane, ...pd.clippingPlane);
		if (u.u_projection_transition)
			gl.uniform1f(u.u_projection_transition, pd.projectionTransition);
		gl.enableVertexAttribArray(A_POS);
		gl.enableVertexAttribArray(A_NORMAL);
		// Opaque solids: depth-test against terrain/each other, cull nothing
		// (interior back-faces are hidden by the front walls anyway).
		gl.enable(gl.DEPTH_TEST);
		gl.depthFunc(gl.LEQUAL);
		gl.disable(gl.CULL_FACE);
		gl.disable(gl.BLEND);

		for (const [key, mesh] of this.meshes.entries()) {
			if (mesh.vertexCount === 0) continue;
			if (u.u_color) {
				gl.uniform3f(u.u_color, ...(this.heroKeys.has(key) ? this.heroColor : this.color));
			}
			gl.bindBuffer(gl.ARRAY_BUFFER, mesh.pos);
			gl.vertexAttribPointer(A_POS, 4, gl.FLOAT, false, 0, 0);
			gl.bindBuffer(gl.ARRAY_BUFFER, mesh.nrm);
			gl.vertexAttribPointer(A_NORMAL, 3, gl.FLOAT, false, 0, 0);
			gl.drawArrays(gl.TRIANGLES, 0, mesh.vertexCount);
		}

		gl.disableVertexAttribArray(A_POS);
		gl.disableVertexAttribArray(A_NORMAL);
	}
}
