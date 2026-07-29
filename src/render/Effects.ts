import * as THREE from 'three';
import { makeGlowTexture, makeSparkTexture } from './Textures';
import { SkidMarks } from './SkidMarks';

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; maxLife: number;
  size: number; sizeEnd: number;
  r: number; g: number; b: number;
  gravity: number; drag: number;
  fadeIn: number;
}

export interface EmitOptions {
  pos: [number, number, number];
  vel: [number, number, number];
  color: number;
  size: number;
  sizeEnd?: number;
  life: number;
  gravity?: number;
  drag?: number;
  /** 淡入时间比例 0..1 */
  fadeIn?: number;
}

/**
 * CPU 粒子池 —— 所有车共用两个池（火花 / 烟雾），
 * 每帧只写一次 buffer，绘制两个 draw call。
 */
export class ParticlePool {
  readonly points: THREE.Points;
  private parts: Particle[] = [];
  private cursor = 0;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private sizeAttr: THREE.BufferAttribute;
  private alphaAttr: THREE.BufferAttribute;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private tex: THREE.Texture;

  constructor(capacity: number, texture: THREE.Texture, renderOrder = 5, brightness = 0.45) {
    this.tex = texture;
    const pos = new Float32Array(capacity * 3);
    const col = new Float32Array(capacity * 3);
    const size = new Float32Array(capacity);
    const alpha = new Float32Array(capacity);
    // 初始全部藏到远处
    for (let i = 0; i < capacity; i++) pos[i * 3 + 1] = -9999;

    this.geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(pos, 3);
    this.colAttr = new THREE.BufferAttribute(col, 3);
    this.sizeAttr = new THREE.BufferAttribute(size, 1);
    this.alphaAttr = new THREE.BufferAttribute(alpha, 1);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr.setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('aColor', this.colAttr);
    this.geo.setAttribute('aSize', this.sizeAttr);
    this.geo.setAttribute('aAlpha', this.alphaAttr);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        // additive 混合下多个粒子重叠会快速超过 1.0，再过 bloom 就是一团白。
        // 这个系数把单粒子亮度压低，“多才亮”而不是“一个就爆”。
        uBrightness: { value: brightness },
      },
      vertexShader: /* glsl */`
        attribute float aSize;
        attribute float aAlpha;
        attribute vec3 aColor;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (420.0 / max(-mv.z, 1.0));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        uniform float uBrightness;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 t = texture2D(uMap, gl_PointCoord);
          if (t.a < 0.01) discard;
          gl_FragColor = vec4(vColor * uBrightness, 1.0) * t * vAlpha;
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;

    for (let i = 0; i < capacity; i++) {
      this.parts.push({
        x: 0, y: -9999, z: 0, vx: 0, vy: 0, vz: 0,
        life: 0, maxLife: 1, size: 1, sizeEnd: 0,
        r: 1, g: 1, b: 1, gravity: 0, drag: 0, fadeIn: 0,
      });
    }
  }

  emit(o: EmitOptions): void {
    const p = this.parts[this.cursor];
    this.cursor = (this.cursor + 1) % this.parts.length;
    p.x = o.pos[0]; p.y = o.pos[1]; p.z = o.pos[2];
    p.vx = o.vel[0]; p.vy = o.vel[1]; p.vz = o.vel[2];
    p.life = p.maxLife = o.life;
    p.size = o.size;
    p.sizeEnd = o.sizeEnd ?? 0;
    p.gravity = o.gravity ?? 0;
    p.drag = o.drag ?? 0;
    p.fadeIn = o.fadeIn ?? 0;
    p.r = ((o.color >> 16) & 255) / 255;
    p.g = ((o.color >> 8) & 255) / 255;
    p.b = (o.color & 255) / 255;
  }

  update(dt: number): void {
    const pos = this.posAttr.array as Float32Array;
    const col = this.colAttr.array as Float32Array;
    const size = this.sizeAttr.array as Float32Array;
    const alpha = this.alphaAttr.array as Float32Array;
    let any = false;

    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      if (p.life <= 0) {
        if (alpha[i] !== 0) { alpha[i] = 0; pos[i * 3 + 1] = -9999; any = true; }
        continue;
      }
      any = true;
      p.life -= dt;
      if (p.life <= 0) { alpha[i] = 0; pos[i * 3 + 1] = -9999; continue; }

      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vz *= k;
      p.vy = p.vy * k + p.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;

      const t = 1 - p.life / p.maxLife; // 0 → 1
      let a = 1 - t;
      if (p.fadeIn > 0 && t < p.fadeIn) a = t / p.fadeIn;
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      col[i * 3] = p.r; col[i * 3 + 1] = p.g; col[i * 3 + 2] = p.b;
      size[i] = p.size + (p.sizeEnd - p.size) * t;
      alpha[i] = a;
    }

    if (any) {
      this.posAttr.needsUpdate = true;
      this.colAttr.needsUpdate = true;
      this.sizeAttr.needsUpdate = true;
      this.alphaAttr.needsUpdate = true;
    }
  }

  clear(): void {
    for (const p of this.parts) p.life = 0;
    this.update(0.001);
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.tex.dispose();
  }
}

/** 场景里所有粒子效果的门面 */
export class Effects {
  readonly sparks: ParticlePool;
  readonly smoke: ParticlePool;
  readonly skid: SkidMarks;
  private group = new THREE.Group();

  constructor(scene: THREE.Scene) {
    this.sparks = new ParticlePool(2400, makeSparkTexture(), 6, 0.12);
    this.smoke = new ParticlePool(1200, makeGlowTexture(), 5, 0.09);
    this.skid = new SkidMarks();
    this.group.add(this.skid.mesh, this.sparks.points, this.smoke.points);
    scene.add(this.group);
  }

  update(dt: number): void {
    this.sparks.update(dt);
    this.smoke.update(dt);
    this.skid.update(dt);
  }

  clear(): void {
    this.sparks.clear();
    this.smoke.clear();
    this.skid.clear();
  }

  dispose(): void {
    this.sparks.dispose();
    this.smoke.dispose();
    this.skid.dispose();
    this.group.removeFromParent();
  }
}

/**
 * 全屏后期：径向速度线 + 色差 + 暗角。
 * 强度由玩家速度/喷射驱动，是"飞车感"最直接的来源。
 */
export const SpeedLinesShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uIntensity: { value: 0 },
    uTime: { value: 0 },
    uAberration: { value: 0 },
    uTint: { value: new THREE.Color(0x66ccff) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uIntensity;
    uniform float uTime;
    uniform float uAberration;
    uniform vec3  uTint;
    varying vec2 vUv;

    float hash(float n) { return fract(sin(n) * 43758.5453123); }

    void main() {
      vec2 c = vUv - 0.5;
      float r = length(c);
      float ang = atan(c.y, c.x);

      // --- 色差：越靠边越明显 ---
      float ab = uAberration * r * 0.018;
      vec2 dir = normalize(c + 1e-6);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + dir * ab).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - dir * ab).b;

      // --- 径向速度线 ---
      if (uIntensity > 0.001) {
        float lanes = 110.0;
        float id = floor((ang / 6.2831853 + 0.5) * lanes);
        float seed = hash(id * 12.9898);
        float speed = 1.4 + seed * 2.6;
        float phase = fract(seed + uTime * speed);
        // 线条从中心往外扫
        float head = phase * 0.72 + 0.14;
        float d = abs(r - head);
        float line = smoothstep(0.030, 0.0, d);
        // 中心留空，边缘最强
        float radial = smoothstep(0.20, 0.68, r);
        float streak = line * radial * step(0.66, seed);
        col += uTint * streak * uIntensity * 0.5;
      }

      // --- 暗角 ---
      float vig = smoothstep(0.95, 0.32, r);
      col *= mix(1.0, vig, 0.35 + uIntensity * 0.2);

      gl_FragColor = vec4(col, 1.0);
    }`,
};
