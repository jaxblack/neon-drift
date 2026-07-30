import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

/**
 * 外部车模（glTF/glb）加载管线。
 *
 * 设计原则：**永远不能因为资产缺失或加载失败就让游戏起不来**。
 * 这里所有失败路径都返回 null，KartVisual 会退回程序化车模继续跑。
 * 资产是增强项，不是依赖项。
 *
 * 约定（见 public/models/README.md）：
 *   - 模型放 public/models/<id>.glb
 *   - 车头朝 +Z，车轮贴地（y=0 为地面）
 *   - 车漆材质名里带 body / paint / carpaint 之一 —— 会被逐车染成阵营色
 *   - 车轮节点名里带 wheel，并含 fl/fr/rl/rr 或 front/rear + left/right
 * 不满足约定也能加载，只是拿不到轮子转动和阵营配色。
 */

/** 车模在游戏里的目标尺寸（米）。所有外部资产都会等比缩放到这个车长。 */
const TARGET_LENGTH = 4.4;

export interface PreparedCarModel {
  scene: THREE.Group;
  /** 按 [前左, 前右, 后左, 后右] 排好的轮子节点；找不到就是空数组 */
  wheels: THREE.Object3D[];
  /** 车漆材质（会被 clone 后逐车染色）*/
  paintMaterials: THREE.MeshStandardMaterial[];
  /** 归一化时用的缩放系数，调试用 */
  scale: number;
}

let loaderPromise: Promise<GLTFLoader> | null = null;

function baseUrl(): string {
  // Vite 的 BASE_URL 结尾一定带 /
  return (import.meta.env.BASE_URL ?? '/');
}

/**
 * 懒建 GLTFLoader。
 * DRACO / KTX2 解码器是自托管的（npm run fetch-decoders 会从 node_modules 拷进 public/decoders）。
 * 模型没用压缩的话这两个解码器根本不会被下载，所以即使没拷也不影响。
 */
async function getLoader(renderer: THREE.WebGLRenderer): Promise<GLTFLoader> {
  if (loaderPromise) return loaderPromise;
  loaderPromise = (async () => {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath(`${baseUrl()}decoders/draco/`);
    loader.setDRACOLoader(draco);
    const ktx2 = new KTX2Loader();
    ktx2.setTranscoderPath(`${baseUrl()}decoders/basis/`);
    ktx2.detectSupport(renderer);
    loader.setKTX2Loader(ktx2);
    return loader;
  })();
  return loaderPromise;
}

const WHEEL_ORDER: Array<[RegExp, RegExp]> = [
  [/fl|front.*left|left.*front/i, /wheel|tire|tyre|rim/i],
  [/fr|front.*right|right.*front/i, /wheel|tire|tyre|rim/i],
  [/rl|rear.*left|left.*rear|bl|back.*left/i, /wheel|tire|tyre|rim/i],
  [/rr|rear.*right|right.*rear|br|back.*right/i, /wheel|tire|tyre|rim/i],
];

/**
 * 加载并归一化一个车模。失败一律返回 null（调用方退回程序化车模）。
 */
export async function loadCarModel(
  url: string,
  renderer: THREE.WebGLRenderer,
): Promise<PreparedCarModel | null> {
  try {
    const loader = await getLoader(renderer);
    const gltf = await loader.loadAsync(url);
    return prepare(gltf.scene);
  } catch (err) {
    // 资产缺失是完全正常的情况（仓库里默认不带车模），不当错误报
    console.info(`[car-model] 未加载 ${url}，使用程序化车模：`, (err as Error)?.message ?? err);
    return null;
  }
}

/**
 * 按 public/models/manifest.json 里的开关决定要不要加载车模。
 *
 * 用清单而不是直接去 fetch car.glb：车模默认不存在，直接请求会让每个玩家的
 * 控制台都躺着一条 404 红字。清单文件是提交进仓库的，一定存在。
 */
export async function loadCarModelFromManifest(
  renderer: THREE.WebGLRenderer,
): Promise<PreparedCarModel | null> {
  const base = baseUrl();
  let file: string | null = null;
  try {
    const res = await fetch(`${base}models/manifest.json`, { cache: 'no-cache' });
    if (!res.ok) return null;
    const manifest = (await res.json()) as { car?: string | null };
    file = manifest.car ?? null;
  } catch {
    return null; // 清单读不到就当没配车模，静默走程序化
  }
  if (!file) return null;
  return loadCarModel(`${base}models/${file}`, renderer);
}

function prepare(raw: THREE.Object3D): PreparedCarModel {
  const scene = new THREE.Group();
  scene.add(raw);

  // ---- 归一化尺寸与位置 ----
  // 外部资产的单位、原点、朝向千奇百怪，不归一化的话每换一个模型都要重调一遍
  // 车轮位置、相机距离、碰撞半径。这里统一到：车长 TARGET_LENGTH、原点在车底中心。
  const box = new THREE.Box3().setFromObject(raw);
  const size = new THREE.Vector3();
  box.getSize(size);
  const longest = Math.max(size.x, size.z);
  const scale = longest > 1e-4 ? TARGET_LENGTH / longest : 1;
  raw.scale.multiplyScalar(scale);

  // 车更长的那个轴当作车身纵向；如果模型是朝 X 的，转 90° 摆正到 +Z
  if (size.x > size.z) raw.rotation.y = Math.PI / 2;

  // 重新量一次（缩放和旋转之后），把原点挪到车底中心
  const box2 = new THREE.Box3().setFromObject(raw);
  const center = new THREE.Vector3();
  box2.getCenter(center);
  raw.position.x -= center.x;
  raw.position.z -= center.z;
  raw.position.y -= box2.min.y;

  // ---- 收集轮子和车漆材质 ----
  const wheels: Array<THREE.Object3D | undefined> = [undefined, undefined, undefined, undefined];
  const paintMaterials: THREE.MeshStandardMaterial[] = [];
  const seenPaint = new Set<THREE.Material>();

  raw.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) {
      // 轮子经常是空节点带子网格，所以节点也要匹配
      matchWheel(o, wheels);
      return;
    }
    const mesh = o as THREE.Mesh;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    matchWheel(mesh, wheels);

    for (const m of materialsOf(mesh)) {
      if (!(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) continue;
      const std = m as THREE.MeshStandardMaterial;
      // 统一给外部材质补上环境反射强度，否则在我们这套夜景里会偏暗
      std.envMapIntensity = Math.max(std.envMapIntensity, 1.4);
      if (/body|paint|carpaint|car_paint|shell/i.test(std.name) && !seenPaint.has(std)) {
        seenPaint.add(std);
        paintMaterials.push(std);
      }
    }
  });

  return {
    scene,
    wheels: wheels.filter((w): w is THREE.Object3D => !!w),
    paintMaterials,
    scale,
  };
}

function matchWheel(o: THREE.Object3D, out: Array<THREE.Object3D | undefined>): void {
  const name = o.name;
  if (!name || !/wheel|tire|tyre|rim/i.test(name)) return;
  for (let i = 0; i < WHEEL_ORDER.length; i++) {
    if (out[i]) continue;
    const [posRe, kindRe] = WHEEL_ORDER[i];
    if (posRe.test(name) && kindRe.test(name)) { out[i] = o; return; }
  }
}

function materialsOf(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/**
 * 给每台车克隆一份。
 * 几何体共享（clone 只复制节点树），车漆材质单独 clone 出来好染阵营色。
 */
export function instantiate(prepared: PreparedCarModel, color: THREE.Color): {
  scene: THREE.Group; wheels: THREE.Object3D[];
} {
  const scene = prepared.scene.clone(true);
  const paintNames = new Set(prepared.paintMaterials.map((m) => m.name));

  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const mats = materialsOf(mesh);
    const next = mats.map((m) => {
      if (!paintNames.has(m.name)) return m; // 非车漆部分共享，省显存
      const c = (m as THREE.MeshStandardMaterial).clone();
      c.color.copy(color);
      // 打个标记，KartVisual.dispose 只释放这些逐车克隆出来的材质，
      // 共享模板材质不能碰（其它车还在用）
      (c as THREE.Material & { __cloned?: boolean }).__cloned = true;
      return c;
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0];
  });

  // clone 之后要按名字重新找轮子，原来的引用指向的是模板
  const wheels: Array<THREE.Object3D | undefined> = [undefined, undefined, undefined, undefined];
  scene.traverse((o) => matchWheel(o, wheels));
  return { scene, wheels: wheels.filter((w): w is THREE.Object3D => !!w) };
}
