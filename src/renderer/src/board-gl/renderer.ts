import type { BoardCamera } from '../../../shared/board'
import {
  buildScene,
  INK,
  INK_COUNT,
  QUAD,
  QUAD_STRIDE,
  QuadList,
  type SceneInput,
  type ThumbWant,
} from './scene'
import { ThumbTextures } from './textures'

/*
 * The board's pixels in WebGL2: the dot grid, then every quad of the scene (scene.ts) as an
 * instance of one unit square, shaped in the fragment shader as a rounded rectangle with a
 * fill, a stroke, a thumbnail or a soft shadow. Rects arrive in board-view pixels (CSS
 * pixels); the shader maps them to the canvas, whose backing store is in device pixels, so
 * script never scales a rect itself.
 */

/** Textures are replaced for the zoom there is once it has held still this long. */
const ZOOM_REST_MS = 120

const QUAD_VERTEX = `#version 300 es
layout(location = 0) in vec4 a_rect;
layout(location = 1) in vec4 a_shape;
layout(location = 2) in vec4 a_paint;
uniform vec2 u_view;
uniform float u_px;
out vec2 v_local;
out vec2 v_half;
flat out vec4 v_shape;
flat out vec4 v_paint;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  // Room for a stroke outside the edge, a shadow's blur, and a pixel of antialiasing.
  float pad = a_shape.z * a_shape.y + 2.0 * a_paint.w + u_px;
  vec2 local = corner * (a_rect.zw + 2.0 * pad) - pad;
  v_local = local;
  v_half = a_rect.zw * 0.5;
  v_shape = a_shape;
  v_paint = a_paint;
  vec2 clip = (a_rect.xy + local) / u_view * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`

const QUAD_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_local;
in vec2 v_half;
flat in vec4 v_shape;
flat in vec4 v_paint;
uniform vec4 u_inks[${INK_COUNT}];
uniform sampler2D u_thumb;
uniform float u_px;
out vec4 color;
float box(vec2 p, vec2 half_size, float radius) {
  vec2 q = abs(p) - half_size + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}
void main() {
  float radius = min(v_shape.x, min(v_half.x, v_half.y));
  float d = box(v_local - v_half, v_half, radius);
  vec4 fill = u_inks[int(v_paint.x)];
  int kind = int(v_shape.w);
  if (kind == ${QUAD.shadow}) {
    float blur = max(v_paint.w, u_px);
    color = fill * (1.0 - smoothstep(-blur, blur, d));
    return;
  }
  // Sampled whatever the kind (derivatives need it): a frame's thumbnail runs across its
  // width from the top, and what's below it is the frame's own fill.
  float image = max(v_paint.z, 1.0);
  // A level sharper than it would pick: at rest a texture is under twice as wide as it's
  // drawn (THUMB_TIERS), where its own pixels look best; smaller levels are for mid-pinch.
  vec4 thumb = texture(u_thumb, vec2(v_local.x / (2.0 * v_half.x), v_local.y / image), -1.0);
  if (kind == ${QUAD.thumb} && v_local.y < v_paint.z) fill = vec4(thumb.rgb, 1.0);
  float width = v_shape.y;
  float outer = d - v_shape.z * width;
  float within = clamp(0.5 - d / u_px, 0.0, 1.0);
  float band = width > 0.0
    ? clamp(0.5 - outer / u_px, 0.0, 1.0) - clamp(0.5 - (outer + width) / u_px, 0.0, 1.0)
    : 0.0;
  vec4 stroke = u_inks[int(v_paint.y)] * band;
  color = stroke + fill * within * (1.0 - stroke.a);
}`

const GRID_VERTEX = `#version 300 es
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`

// CSS's radial-gradient(ink 1px, transparent 1px), tiled: a dot a pixel in radius at the
// middle of every cell.
const GRID_FRAGMENT = `#version 300 es
precision highp float;
uniform vec4 u_ink;
uniform vec3 u_grid;
uniform float u_px;
uniform float u_height;
out vec4 color;
void main() {
  vec2 at = vec2(gl_FragCoord.x, u_height - gl_FragCoord.y) * u_px;
  vec2 cell = mod(at - u_grid.yz, u_grid.x) - 0.5 * u_grid.x;
  color = u_ink * clamp(0.5 - (length(cell) - 1.0) / u_px, 0.0, 1.0);
}`

function program(gl: WebGL2RenderingContext, vertex: string, fragment: string) {
  const made = gl.createProgram()
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type)
    if (!shader) throw new Error('The board could not make a shader')
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    gl.attachShader(made, shader)
    gl.deleteShader(shader)
  }
  gl.linkProgram(made)
  // A lost context fails every link: the restored one makes them again.
  if (!gl.getProgramParameter(made, gl.LINK_STATUS) && !gl.isContextLost())
    throw new Error(`The board's shader did not link: ${gl.getProgramInfoLog(made)}`)
  return made
}

export class BoardRenderer {
  private readonly gl: WebGL2RenderingContext
  private readonly textures: ThumbTextures
  private readonly quads = new QuadList()
  private inks: Float32Array = new Float32Array(INK_COUNT * 4)
  private view = { width: 0, height: 0 }
  private scale = 1
  /** The zoom last drawn, and when it last changed */
  private zoom = 0
  private zoomedAt = 0
  private lost = false
  // Everything below is the context's own, made again when a lost one comes back.
  private quadProgram!: WebGLProgram
  private gridProgram!: WebGLProgram
  private instances!: WebGLBuffer
  private blank!: WebGLTexture
  private uniforms!: Record<
    'view' | 'px' | 'inks' | 'gridInk' | 'grid' | 'gridPx' | 'gridHeight',
    WebGLUniformLocation | null
  >

  constructor(
    private readonly canvas: HTMLCanvasElement,
    thumbUrl: (want: ThumbWant) => string,
    changed: () => void,
  ) {
    const gl = canvas.getContext('webgl2', {
      // Opaque: the board's own colour is the first thing drawn, and nothing shows through.
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    })
    if (!gl) throw new Error('This display has no WebGL2')
    this.gl = gl
    this.textures = new ThumbTextures(gl, thumbUrl, changed)
    this.setUp()
  }

  private setUp() {
    const { gl } = this
    this.quadProgram = program(gl, QUAD_VERTEX, QUAD_FRAGMENT)
    this.gridProgram = program(gl, GRID_VERTEX, GRID_FRAGMENT)
    const at = (made: WebGLProgram, name: string) => gl.getUniformLocation(made, name)
    this.uniforms = {
      view: at(this.quadProgram, 'u_view'),
      px: at(this.quadProgram, 'u_px'),
      inks: at(this.quadProgram, 'u_inks'),
      gridInk: at(this.gridProgram, 'u_ink'),
      grid: at(this.gridProgram, 'u_grid'),
      gridPx: at(this.gridProgram, 'u_px'),
      gridHeight: at(this.gridProgram, 'u_height'),
    }
    this.instances = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances)
    for (let slot = 0; slot < 3; slot++) {
      gl.enableVertexAttribArray(slot)
      gl.vertexAttribDivisor(slot, 1)
    }
    // What a quad without a thumbnail samples.
    this.blank = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.blank)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]),
    )
    gl.enable(gl.BLEND)
    // Inks are premultiplied.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  /** The view's size in CSS pixels and the canvas's in device pixels. */
  resize(view: { width: number; height: number }, device: { width: number; height: number }) {
    this.view = view
    this.scale = view.width > 0 ? device.width / view.width : 1
    if (this.canvas.width !== device.width) this.canvas.width = device.width
    if (this.canvas.height !== device.height) this.canvas.height = device.height
    // What's in view holds at most three times the canvas's pixels (`THUMB_TIERS`), and a
    // third again in mip levels; the rest is room for what was just looked at.
    this.textures.budget = device.width * device.height * 4 * 3 * (4 / 3) + 32 * 1048576
  }

  /** Each ink's colour, premultiplied: INK_COUNT × rgba. */
  setInks(inks: Float32Array) {
    this.inks = inks
  }

  keep(ids: ReadonlySet<string>) {
    this.textures.keep(ids)
  }

  /** Draws the board. Returns how soon it wants drawing again (ms), or null if it doesn't. */
  draw(input: SceneInput, camera: BoardCamera, now: number): number | null {
    const { gl, view } = this
    if (this.lost || view.width <= 0 || view.height <= 0) return null
    const px = 1 / this.scale
    const scene = buildScene(input, camera, view, this.scale, this.quads)
    const { quads } = scene
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    const canvas = INK.canvas * 4
    gl.clearColor(this.inks[canvas], this.inks[canvas + 1], this.inks[canvas + 2], 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    if (scene.grid) {
      this.select(this.gridProgram)
      gl.uniform4fv(
        this.uniforms.gridInk,
        this.inks.subarray(INK.lineStrong * 4, INK.lineStrong * 4 + 4),
      )
      gl.uniform3f(this.uniforms.grid, scene.grid.size, scene.grid.x, scene.grid.y)
      gl.uniform1f(this.uniforms.gridPx, px)
      gl.uniform1f(this.uniforms.gridHeight, this.canvas.height)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }

    // Each frame's texture, and how tall its thumbnail is on screen: as wide as the frame.
    const drawn: (WebGLTexture | undefined)[] = []
    for (let index = 0; index < quads.count; index++) {
      const want = quads.thumbs[index]
      if (!want) continue
      const at = index * QUAD_STRIDE
      const held = this.textures.use(want)
      if (held?.texture) {
        drawn[index] = held.texture
        quads.data[at + 10] = (quads.data[at + 2] * held.height) / held.width
      } else quads.data[at + 7] = QUAD.flat
    }

    this.select(this.quadProgram)
    gl.uniform2f(this.uniforms.view, view.width, view.height)
    gl.uniform1f(this.uniforms.px, px)
    gl.uniform4fv(this.uniforms.inks, this.inks)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      quads.data.subarray(0, quads.count * QUAD_STRIDE),
      gl.DYNAMIC_DRAW,
    )
    const bytes = QUAD_STRIDE * 4
    const run = (first: number, count: number, texture: WebGLTexture) => {
      if (count <= 0) return
      gl.bindTexture(gl.TEXTURE_2D, texture)
      for (let slot = 0; slot < 3; slot++)
        gl.vertexAttribPointer(slot, 4, gl.FLOAT, false, bytes, first * bytes + slot * 16)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count)
    }
    // Quads without a thumbnail go together; each with one is a draw of its own, in order.
    let first = 0
    for (let index = 0; index < quads.count; index++) {
      const texture = drawn[index]
      if (!texture) continue
      run(first, index - first, this.blank)
      run(index, 1, texture)
      first = index + 1
    }
    run(first, quads.count - first, this.blank)

    if (camera.zoom !== this.zoom) {
      this.zoom = camera.zoom
      this.zoomedAt = now
    }
    return this.textures.settle(Math.max(0, ZOOM_REST_MS - (now - this.zoomedAt)))
  }

  private select(made: WebGLProgram) {
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook.
    this.gl.useProgram(made)
  }

  /**
   * Gives back a buffer the canvas no longer needs. Chromium keeps several behind the one
   * being drawn, each the canvas's size in device pixels (20 MB at 1440 × 870 on a Retina
   * display), for as long as the canvas keeps its size: so it's made a row taller and put
   * back. That leaves it blank until the draw that must follow in the same task. Measured:
   * one buffer's worth less in the GPU process at rest (docs/webgl-board/README.md).
   */
  trim() {
    if (this.lost) return
    const { height } = this.canvas
    this.canvas.height = height + 1
    this.canvas.height = height
  }

  /** The GPU context went (the driver reset, the GPU process restarted): nothing draws. */
  contextLost() {
    this.lost = true
    this.textures.lost()
  }

  /** And came back: its programs and buffers are made again, and textures load as drawn. */
  contextRestored() {
    this.setUp()
    this.lost = false
  }

  dispose() {
    this.textures.dispose()
    const { gl } = this
    gl.deleteProgram(this.quadProgram)
    gl.deleteProgram(this.gridProgram)
    gl.deleteBuffer(this.instances)
    gl.deleteTexture(this.blank)
    // The drawing buffer goes now rather than when the canvas is collected. The context
    // itself stays as it is: the same canvas may be given a renderer again (a remount).
    this.canvas.width = 0
    this.canvas.height = 0
    this.lost = true
  }
}
