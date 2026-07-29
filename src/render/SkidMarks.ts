import * as THREE from 'three';

/**
 * 地面胎印（skid marks）。
 *
 * 实现要点：
 * - 一整块固定容量的 BufferGeometry 环形缓冲，写满后从头覆盖 —— 全程零分配，
 *   不会因为长时间比赛导致 GC 抖动。
 * - 每个轮子记住上一次落点，移动超过阈值就补一个四边形（上次位置 → 这次位置），
 *   四边形宽度就是胎宽，于是连起来就是一条连续的黑带。
 * - 淡出用顶点 alpha，在 shader 里按"写入时间"算，不需要每帧回写整个 buffer。
 * - polygonOffset + depthWrite:false 避免和路面 z-fighting。
 */

const VERTS_PER_QUAD = 4;
const INDICES_PER_QUAD = 6;

export interface SkidEmitter {
  /** 上一次落点，null 表示这条痕迹刚断开 */
  last: THREE.Vector3 | null;
}

export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private posAttr: THREE.BufferAttribute;
  private birthAttr: THREE.BufferAttribute;
  private opacityAttr: THREE.BufferAttribute;
  private cursor = 0;
  private readonly capacity: number;
  private time = 0;
  /** 痕迹存活时长（秒） */
  private readonly life: number;

  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpDir = new THREE.Vector3();
  private tmpSide = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);

  constructor(capacity = 1400, life = 9) {
    this.capacity = capacity;
    this.life = life;

    const pos = new Float32Array(capacity * VERTS_PER_QUAD * 3);
    const birth = new Float32Array(capacity * VERTS_PER_QUAD);
    const opacity = new Float32Array(capacity * VERTS_PER_QUAD);
    // 初始全部藏起来（birth 设成很久以前，alpha 自然为 0）
    birth.fill(-1e6);

    const idx = new Uint32Array(capacity * INDICES_PER_QUAD);
    for (let q = 0; q < capacity; q++) {
      const v = q * VERTS_PER_QUAD;
      const i = q * INDICES_PER_QUAD;
      idx[i] = v; idx[i + 1] = v + 2; idx[i + 2] = v + 1;
      idx[i + 3] = v + 1; idx[i + 4] = v + 2; idx[i + 5] = v + 3;
    }

    this.geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.birthAttr = new THREE.BufferAttribute(birth, 1).setUsage(THREE.DynamicDrawUsage);
    this.opacityAttr = new THREE.BufferAttribute(opacity, 1).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('aBirth', this.birthAttr);
    this.geo.setAttribute('aOpacity', this.opacityAttr);
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLife: { value: life },
        uColor: { value: new THREE.Color(0x05060a) },
      },
      vertexShader: /* glsl */`
        attribute float aBirth;
        attribute float aOpacity;
        uniform float uTime;
        uniform float uLife;
        varying float vAlpha;
        void main() {
          float age = uTime - aBirth;
          // 末尾 35% 的寿命用来淡出
          vAlpha = aOpacity * clamp(1.0 - max(age - uLife * 0.65, 0.0) / (uLife * 0.35), 0.0, 1.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          if (vAlpha < 0.004) discard;
          gl_FragColor = vec4(uColor, vAlpha);
        }`,
      transparent: true,
      depthWrite: false,
      // 胎印是贴地平面，绕序稍有不慎法线就朝下被背面剔除（赛道 ribbon 踩过同样的坑，
      // 现象是数据全对、位置全对，就是渲染不出来）。平面双面渲染没有代价，直接锁死。
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });

    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /**
   * 从 `from` 到 `to` 补一段胎印。
   * @param width 胎宽
   * @param opacity 0..1，漂移越狠印得越黑
   */
  addSegment(from: THREE.Vector3, to: THREE.Vector3, width: number, opacity: number): void {
    this.tmpDir.subVectors(to, from);
    const len = this.tmpDir.length();
    if (len < 1e-4) return;
    this.tmpDir.divideScalar(len);
    // 侧向 = 前进方向 × 上，得到贴地的横向
    this.tmpSide.crossVectors(this.tmpDir, this.up).normalize().multiplyScalar(width * 0.5);

    const q = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const base = q * VERTS_PER_QUAD;
    const pos = this.posAttr.array as Float32Array;
    const birth = this.birthAttr.array as Float32Array;
    const op = this.opacityAttr.array as Float32Array;

    this.tmpA.copy(from).sub(this.tmpSide);
    this.tmpB.copy(from).add(this.tmpSide);
    const write = (vi: number, v: THREE.Vector3) => {
      const k = (base + vi) * 3;
      pos[k] = v.x; pos[k + 1] = v.y; pos[k + 2] = v.z;
      birth[base + vi] = this.time;
      op[base + vi] = opacity;
    };
    write(0, this.tmpA);
    write(1, this.tmpB);
    this.tmpA.copy(to).sub(this.tmpSide);
    this.tmpB.copy(to).add(this.tmpSide);
    write(2, this.tmpA);
    write(3, this.tmpB);

    this.posAttr.needsUpdate = true;
    this.birthAttr.needsUpdate = true;
    this.opacityAttr.needsUpdate = true;
  }

  update(dt: number): void {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
  }

  clear(): void {
    const birth = this.birthAttr.array as Float32Array;
    birth.fill(-1e6);
    this.birthAttr.needsUpdate = true;
    this.cursor = 0;
  }

  get lifeSeconds(): number { return this.life; }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
