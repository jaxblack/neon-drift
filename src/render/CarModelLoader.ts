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

/**
 * 基础离地间隙（米）。
 * 只管平地；俯仰/侧倾造成的下沉由 KartVisual 里的姿态补偿抬升处理。
 */
const RIDE_HEIGHT = 0.035;

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

/** 车轮槽位：0=前左 1=前右 2=后左 3=后右 */
type Slot = 0 | 1 | 2 | 3;

/**
 * 从节点名判断这是哪个轮子。
 *
 * 两个必须小心的地方（都是在 Khronos CarConcept 上实测踩到的）：
 *   1. FL/FR/RL/RR 两字母代号必须要求前后不是字母。否则 "WheelFrontL" 里
 *      "Front" 的 fr 会命中，左前轮被判成右前轮。
 *   2. 方向盘（SteeringWheel）名字里也有 wheel，要排掉。
 */
function wheelSlot(name: string): Slot | null {
  if (!name || !/wheel|tire|tyre|rim/i.test(name)) return null;
  if (/steer/i.test(name)) return null;
  const n = name.toLowerCase();

  let lon: 'f' | 'r' | null = /front/.test(n) ? 'f' : /rear|back/.test(n) ? 'r' : null;
  let lat: 'l' | 'r' | null = /left/.test(n) ? 'l' : /right/.test(n) ? 'r' : null;

  // WheelFrontL / Wheel_Rear_R 这种在 front/rear 后面直接跟单字母的写法
  if (lon && !lat) {
    const m = /(?:front|rear|back)[_\- ]?([lr])(?![a-z])/.exec(n);
    if (m) lat = m[1] as 'l' | 'r';
  }
  // FL/FR/RL/RR 代号
  if (!lon || !lat) {
    const m = /(?<![a-z])([fr])([lr])(?![a-z])/.exec(n);
    if (m) {
      lon = lon ?? (m[1] as 'f' | 'r');
      lat = lat ?? (m[2] as 'l' | 'r');
    }
  }
  if (!lon || !lat) return null;
  return ((lon === 'f' ? 0 : 2) + (lat === 'l' ? 0 : 1)) as Slot;
}

/**
 * 收集四个车轮。
 *
 * 同一个槽位往往会匹配到一串节点（WheelFrontL / WheelFrontLRim /
 * WheelFrontLBrakeDisc …）。取名字最短的那个——它是父节点，转它会带着轮辋和
 * 刹车盘一起转；转子节点的话轮辋转了轮胎不动。
 *
 * 四个轮子没凑齐就整个放弃：宁可不转，也不能把左前轮的旋转套到右后轮上。
 */
function collectWheels(root: THREE.Object3D): THREE.Object3D[] {
  const best: Array<THREE.Object3D | null> = [null, null, null, null];
  root.traverse((o) => {
    const slot = wheelSlot(o.name);
    if (slot === null) return;
    const cur = best[slot];
    if (!cur || o.name.length < cur.name.length) best[slot] = o;
  });
  return best.every((w) => w) ? (best as THREE.Object3D[]) : [];
}

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
  // 车底刚好贴 y=0 的话，一上坡道或侧倾就会有一角扎进路面——
  // 物理只保证接触点在地面上，车身是刚体，姿态一变最低点就下去了。
  // 抬一点点离地间隙把这个穿模吃掉，视觉上也更像有悬挂的车。
  raw.position.y -= box2.min.y - RIDE_HEIGHT;

  // ---- 收集车漆材质 + 决定谁投影 ----
  const paintMaterials: THREE.MeshStandardMaterial[] = [];
  const seenPaint = new Set<THREE.Material>();

  // 一台写实车模有近百个网格（螺丝、内饰、刹车卡钳……）。
  // 八台车全量投影 = 900+ 个 shadow caster，阴影 pass 要把它们全部重画一遍，
  // 实测帧率从 60 掉到 36。按尺寸阈值筛还剩 624 个、45 fps，依然不够。
  //
  // 改成硬上限：每台车只取体积最大的 N 个网格投影。这样 caster 数量是有界的
  // （8 车 × 14 = 112），而车身板件和四个轮子必然在这 N 个里面——
  // 阴影里真正能分辨出来的就是它们，内饰和小五金投不投完全看不出区别。
  const MAX_CASTERS_PER_CAR = 14;
  // 写实车模会把内饰完整建出来（仪表台、座椅、踏板、方向盘…），
  // 在这台车上占了 97 个网格里的 42 个。但这是追尾视角的街机赛车，
  // 隔着一块深色风挡、八台车同屏，内饰一帧都看不清，却要吃掉 8×42=336 次 draw call。
  // 直接整体隐藏。想看内饰的话把这个正则清空即可。
  const HIDE_INTERIOR = /interior|dash|floormat|seat|pedal|steering/i;
  raw.updateMatrixWorld(true);
  const bb = new THREE.Box3();
  const sz = new THREE.Vector3();
  const sized: Array<{ mesh: THREE.Mesh; size: number }> = [];

  raw.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (HIDE_INTERIOR.test(mesh.name) || HIDE_INTERIOR.test(mesh.parent?.name ?? '')) {
      mesh.visible = false;
      return;
    }
    mesh.geometry.computeBoundingBox();
    bb.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
    bb.getSize(sz);
    sized.push({ mesh, size: sz.x * sz.y + sz.y * sz.z + sz.z * sz.x }); // 表面积近似
    mesh.castShadow = false;
    mesh.receiveShadow = true;

    for (const m of materialsOf(mesh)) {
      if (!(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) continue;
      const std = m as THREE.MeshStandardMaterial;
      // 统一给外部材质补上环境反射强度，否则在我们这套夜景里会偏暗
      std.envMapIntensity = Math.max(std.envMapIntensity, 1.4);
      // 展厅资产的自发光强度是按静态渲染调的（这台车用了
      // KHR_materials_emissive_strength），配上我们的 bloom 会直接烧成白色——
      // 尾灯看着像前灯，跟在别人车后完全分不清车头车尾。压到能发光但不过曝。
      if (std.emissive && std.emissiveIntensity > 1.6) std.emissiveIntensity = 1.6;
      if (/body|paint|carpaint|car_paint|shell/i.test(std.name ?? '') && !seenPaint.has(std)) {
        seenPaint.add(std);
        paintMaterials.push(std);
      }
    }
  });

  sized.sort((a, b) => b.size - a.size);
  for (const s of sized.slice(0, MAX_CASTERS_PER_CAR)) s.mesh.castShadow = true;

  return {
    scene,
    wheels: collectWheels(raw),
    paintMaterials,
    scale,
  };
}

function materialsOf(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/**
 * 给每台车克隆一份。
 * 几何体共享（clone 只复制节点树），车漆材质单独 clone 出来好染阵营色。
 * 传了 finish 就连漆面质感（金属度/粗糙度/清漆）一起换——玩家选车型靠的就是这个。
 */
export function instantiate(
  prepared: PreparedCarModel,
  color: THREE.Color,
  finish?: { metalness: number; roughness: number; clearcoat: number },
): {
  scene: THREE.Group; wheels: THREE.Object3D[];
} {
  const scene = prepared.scene.clone(true);
  const paintNames = new Set(prepared.paintMaterials.map((m) => m.name));

  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // castShadow 在 prepare() 里已经按尺寸决定好了，clone 会继承，别在这里覆盖成 true——
    // 那样等于把筛选白做了，八台车又变回 900+ 个 caster。
    const mats = materialsOf(mesh);
    const next = mats.map((m) => {
      if (!paintNames.has(m.name)) return m; // 非车漆部分共享，省显存
      const c = (m as THREE.MeshStandardMaterial).clone();
      c.color.copy(color);
      if (finish) {
        c.metalness = finish.metalness;
        c.roughness = finish.roughness;
        const phys = c as THREE.MeshPhysicalMaterial;
        if (phys.clearcoat !== undefined) phys.clearcoat = finish.clearcoat;
      }
      // 打个标记，KartVisual.dispose 只释放这些逐车克隆出来的材质，
      // 共享模板材质不能碰（其它车还在用）
      (c as THREE.Material & { __cloned?: boolean }).__cloned = true;
      return c;
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0];
  });

  // clone 之后要按名字重新找轮子，原来的引用指向的是模板
  return { scene, wheels: collectWheels(scene) };
}
