// GPU fire. A fragment shader builds each flame from layered, domain-warped noise
// rising through a teardrop mask, colored by the burner's palette.

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uCore;
uniform vec3 uMid;
uniform vec3 uOuter;
uniform float uScale;
uniform float uBright;
uniform float uBoost;
uniform float uSeed;

// Precision-safe hash (Dave Hoskins, "hash without sine"): scales inputs down before fract,
// so noise stays smooth even when time-driven coordinates grow large.
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  float s = max(0.001, uScale * (1.0 + uBoost * 0.45));
  // Flame space: x centered, y from the base upward, scaled so height 1.0 is the flame tip.
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.1) / (s * 0.92);
  float t = uTime * (1.0 + uBoost * 0.6);

  vec2 q = vec2(p.x * 2.6, p.y * 1.8 - t * 1.9);
  float n = fbm(q + uSeed);
  float n2 = fbm(q * 2.3 + vec2(n * 1.7, -t * 1.1) + uSeed * 1.7);

  float h = clamp(p.y, 0.0, 2.0);
  // Heat warp grows with height, so the base is steady and the tip dances.
  float x = p.x + (n2 - 0.5) * 0.5 * h + sin(t * 1.3 + uSeed) * 0.03 * h;
  // Teardrop: rounded at the base, widest just above it, tapering to a point.
  float round = sqrt(clamp(p.y / 0.16 + 0.15, 0.0, 1.0));
  float width = 0.25 * pow(max(0.0, 1.0 - h * 0.95), 0.75) * round * (0.8 + 0.4 * n);
  float edge = abs(x) / max(width, 0.0001);
  float body = 1.0 - smoothstep(0.2, 1.0, edge);
  float fade = 1.0 - smoothstep(0.1, 1.0, h + (n2 - 0.5) * 0.6);
  float f = clamp(body * fade * 1.25, 0.0, 1.0);
  // Separate licks of flame breaking off near the top.
  float licks = smoothstep(0.6, 0.85, n2) * (1.0 - smoothstep(0.45, 1.2, h)) * (1.0 - smoothstep(0.0, width * 1.8 + 0.02, abs(x)));
  f = max(f, licks * 0.55);
  // Hot core: a narrower, brighter tongue inside the body.
  float core = (1.0 - smoothstep(0.0, 0.55, edge)) * (1.0 - smoothstep(0.0, 0.55, h + (n - 0.5) * 0.3));

  vec3 col = mix(uOuter * 0.3, uOuter, smoothstep(0.0, 0.35, f));
  col = mix(col, uMid, smoothstep(0.35, 0.8, f));
  col = mix(col, uCore, core * 0.85);

  // Soft bloom halo and a glowing coal bed at the base.
  float d = length(vec2(p.x * 1.2, (p.y - 0.25) * 0.8));
  float halo = exp(-d * d * 6.0) * (0.22 + 0.25 * uBoost);
  float bed = exp(-(p.x * p.x * 30.0 + (p.y + 0.01) * (p.y + 0.01) * 400.0)) * 0.55;
  vec3 outc = col * f * 1.35 + uMid * halo * 0.5 + uMid * bed * 0.7;
  float alpha = clamp(f * 1.2 + halo * 0.7 + bed * 0.6, 0.0, 1.0);
  gl_FragColor = vec4(outc * uBright, alpha * uBright);
}
`;

function hexToVec(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export interface ShaderFlameState {
  scale: number;
  brightness: number;
  boost: number;
}

export class ShaderFlame {
  private gl: WebGLRenderingContext;
  private prog: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private seed = Math.random() * 50;

  static supported(): boolean {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
    } catch {
      return false;
    }
  }

  constructor(
    private canvas: HTMLCanvasElement,
    palette: { core: string; mid: string; outer: string },
  ) {
    const gl = canvas.getContext('webgl', {
      premultipliedAlpha: true,
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: import.meta.env.DEV, // lets dev screenshots capture frames
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader');
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
    this.prog = prog;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const name of ['uRes', 'uTime', 'uCore', 'uMid', 'uOuter', 'uScale', 'uBright', 'uBoost', 'uSeed']) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }
    gl.uniform3fv(this.u.uCore, hexToVec(palette.core));
    gl.uniform3fv(this.u.uMid, hexToVec(palette.mid));
    gl.uniform3fv(this.u.uOuter, hexToVec(palette.outer));
    gl.uniform1f(this.u.uSeed, this.seed);
  }

  resize(cssW: number, cssH: number) {
    // Fire is soft; rendering near 1x CSS pixels looks identical and saves the GPU.
    const scale = Math.min(window.devicePixelRatio || 1, 1.5);
    this.canvas.width = Math.max(1, Math.round(cssW * scale));
    this.canvas.height = Math.max(1, Math.round(cssH * scale));
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  render(time: number, s: ShaderFlameState) {
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.uniform2f(this.u.uRes, this.canvas.width, this.canvas.height);
    // Wrap the clock hourly so noise coordinates never grow large enough to lose precision.
    gl.uniform1f(this.u.uTime, time % 3600);
    gl.uniform1f(this.u.uScale, s.scale);
    gl.uniform1f(this.u.uBright, s.brightness);
    gl.uniform1f(this.u.uBoost, s.boost);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
