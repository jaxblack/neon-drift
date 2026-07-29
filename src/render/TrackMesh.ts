import * as THREE from 'three';
import type { Track } from '../track/Track';
import { SHOULDER } from '../physics/Kart';
import { mulberry32, TAU } from '../core/MathUtil';
import {
  makeRoadTexture, makeGroundTexture, makeStartLineTexture,
  makeBoostPadTexture, makeBuildingTexture, makeCurbTexture, makeBarrierTexture,
  makeRockTexture,
} from './Textures';

/** 路面纹理沿赛道每多少米重复一次 */
const TEX_LEN = 24;
/** 彩虹路面的重复长度更短，一屏能看到好几条色带 */
const RAINBOW_TEX_LEN = 13;
/** 路缘石一组红白的长度（m）。太短的话远处会被 mipmap 平均成一片粉白 */
const CURB_TEX_LEN = 6.5;
/** 路面横向细分列数（越多跳台的横向过渡越平滑） */
const COLS = 11;
const RAIL_H = 1.35;

export interface TrackVisual {
  group: THREE.Group;
  boostPads: THREE.Object3D[];
  /** 每渲染帧调用，做赛道上的循环动画 */
  update(time: number): void;
  dispose(): void;
}

export function buildTrackVisual(track: Track): TrackVisual {
  const group = new THREE.Group();
  const theme = track.def.theme;
  const disposables: Array<{ dispose(): void }> = [];

  const reg = <T extends { dispose(): void }>(x: T): T => { disposables.push(x); return x; };

  // ================= 路面 =================
  const roadTex = reg(makeRoadTexture(theme.road, theme.roadEdge, theme.rainbow));
  const roadMat = reg(new THREE.MeshStandardMaterial({
    map: roadTex,
    // 夜间沥青不是哑光的。roughness 从 0.82 降下来、配上环境贴图，
    // 路面才会把天空和霓虹灯拉出一道道倒影——夜景赛车的"湿路感"全靠这个。
    roughness: theme.rainbow ? 0.42 : 0.62,
    metalness: theme.rainbow ? 0.25 : 0.1,
    envMapIntensity: theme.rainbow ? 0.6 : 0.55,
    // 暗色主题下光照不足时也要能看清路面，给一点自发光兜底
    emissiveMap: roadTex, emissive: 0xffffff, emissiveIntensity: theme.rainbow ? 0.95 : 0.07,
  }));
  const roadGeo = reg(buildRibbon(
    track, COLS, (t) => ({ from: -t.half, to: t.half }), true, 0,
    theme.rainbow ? RAINBOW_TEX_LEN : TEX_LEN,
  ));
  const road = new THREE.Mesh(roadGeo, roadMat);
  road.receiveShadow = true;
  group.add(road);

  // ================= 路缘石（curb） =================
  // 赛道最标志性的视觉元素。弯道处铺得宽一点，直道窄，和真实赛道一样。
  {
    const curbTex = reg(makeCurbTexture(
      theme.rainbow ? 0x22e6ff : 0xff4a35,
      theme.rainbow ? 0xffffff : 0xf8fafe,
    ));
    const curbMat = reg(new THREE.MeshStandardMaterial({
      map: curbTex, roughness: 0.62, metalness: 0.02,
      // 夜景下纯反射的红段会黑成一片；但自发光给高了白段会过 bloom 阈值，
      // 光晕反过来又把红段吞掉，所以取个不高不低的值
      emissiveMap: curbTex, emissive: 0xffffff, emissiveIntensity: 0.2,
    }));
    for (const side of [1, -1] as const) {
      const geo = reg(buildRibbon(
        track, 2,
        (t) => {
          // 弯道更宽（曲率越大越宽），直道也留一条清楚的边
          const w = 1.7 + Math.min(Math.abs(t.curv) * 260, 1) * 1.8;
          return { from: side * t.half, to: side * (t.half + w) };
        },
        true, 0.035, CURB_TEX_LEN,
      ));
      const m = new THREE.Mesh(geo, curbMat);
      m.receiveShadow = true;
      group.add(m);
    }
  }

  // 路缘霓虹条已移除：它是早期为了“看清赛道边界”的临时方案，
  // toneMapped:false 的高亮会盖掉路缘石。现在边界交给红白 curb 表达。

  // ================= 路肩（草地） =================
  // 悬空赛道没有路肩，路面外就是虚空
  if (!theme.floating) {
    const grassTex = reg(makeGroundTexture(theme.ground));
    const grassMat = reg(new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 }));
    const leftShoulder = new THREE.Mesh(
      reg(buildRibbon(track, 3, (t) => ({ from: t.half, to: t.half + SHOULDER }), false, 0.06)),
      grassMat,
    );
    const rightShoulder = new THREE.Mesh(
      reg(buildRibbon(track, 3, (t) => ({ from: -t.half - SHOULDER, to: -t.half }), false, 0.06)),
      grassMat,
    );
    leftShoulder.receiveShadow = rightShoulder.receiveShadow = true;
    group.add(leftShoulder, rightShoulder);
  }

  // ================= 护栏 =================
  const railGlowMat = reg(new THREE.MeshBasicMaterial({
    color: theme.guardrail, side: THREE.DoubleSide, toneMapped: false,
  }));
  const barrierTex = reg(makeBarrierTexture(theme.accent, theme.guardrail));
  const railBase = reg(new THREE.MeshStandardMaterial({
    map: barrierTex, roughness: 0.62, metalness: 0.2, side: THREE.DoubleSide,
    emissiveMap: barrierTex, emissive: 0xffffff, emissiveIntensity: 0.2,
  }));
  for (const side of [1, -1] as const) {
    const wall = new THREE.Mesh(reg(buildWall(track, side, RAIL_H)), railBase);
    group.add(wall);
    const glow = new THREE.Mesh(reg(buildWallStripe(track, side, RAIL_H * 0.78, RAIL_H * 0.94)), railGlowMat);
    group.add(glow);
  }

  // ================= 起跑线 =================
  {
    const tex = reg(makeStartLineTexture());
    const mat = reg(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    const s = track.sampleAt(0);
    const geo = reg(new THREE.PlaneGeometry(s.half * 2, 5));
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = -Math.atan2(s.fz, s.fx) + Math.PI / 2;
    m.position.set(s.x, s.y + 0.045, s.z);
    m.renderOrder = 2;
    group.add(m);

    // 起跑门架
    const gantry = buildGantry(track, theme.accent);
    group.add(gantry.obj);
    gantry.disposables.forEach((d) => disposables.push(d));
  }

  // ================= 加速带 =================
  const boostPads: THREE.Object3D[] = [];
  let padMat: THREE.MeshBasicMaterial;
  {
    const tex = reg(makeBoostPadTexture(theme.accent));
    const mat = reg(new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false,
    }));
    padMat = mat;
    const geo = reg(new THREE.PlaneGeometry(6, 13));
    for (const p of track.pads) {
      const s = track.sampleAt(p.dist);
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = -Math.atan2(s.fz, s.fx) + Math.PI / 2;
      const y = s.y - Math.sin(s.bank) * p.offset + track.rampLift(p.dist, p.offset);
      m.position.set(s.x + s.lx * p.offset, y + 0.06, s.z + s.lz * p.offset);
      m.renderOrder = 3;
      m.userData.pad = p;
      group.add(m);
      boostPads.push(m);
    }
  }

  // ================= 道具箱（已移除，纯竞速） =================

  // ================= 环境装饰 =================
  const env = buildEnvironment(track);
  group.add(env.obj);
  env.disposables.forEach((d) => disposables.push(d));

  // ================= 沿路霓虹柱（速度感来源） =================
  {
    const pillars = buildNeonPosts(track, theme.roadEdge, theme.accent);
    group.add(pillars.obj);
    pillars.disposables.forEach((d) => disposables.push(d));
  }

  return {
    group,
    boostPads,
    update(time) {
      // 加速带呼吸发光，远远就能看到
      padMat.opacity = 0.62 + Math.sin(time * 5.5) * 0.28;
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
      group.clear();
    },
  };
}

// ===================================================================
// 几何构建
// ===================================================================

/** 沿赛道生成一条带状 mesh。fromTo 决定横向范围（相对中心线的 offset） */
function buildRibbon(
  track: Track,
  cols: number,
  fromTo: (t: { half: number; curv: number }) => { from: number; to: number },
  isRoad: boolean,
  yOffset = 0,
  texLen = TEX_LEN,
): THREE.BufferGeometry {
  const N = track.samples.length;
  const rows = N + 1; // 闭合：末行复制首行
  const pos = new Float32Array(rows * cols * 3);
  const uv = new Float32Array(rows * cols * 2);
  const nrm = new Float32Array(rows * cols * 3);
  const idx: number[] = [];

  for (let i = 0; i < rows; i++) {
    const s = track.samples[i % N];
    const dist = i === N ? track.length : s.dist;
    const { from, to } = fromTo(s);
    for (let j = 0; j < cols; j++) {
      const u = j / (cols - 1);
      const off = from + (to - from) * u;
      const lift = track.rampLift(dist, off);
      const y = s.y - Math.sin(s.bank) * off + lift + yOffset;
      const k = (i * cols + j) * 3;
      pos[k] = s.x + s.lx * off;
      pos[k + 1] = y;
      pos[k + 2] = s.z + s.lz * off;
      const k2 = (i * cols + j) * 2;
      if (isRoad) {
        uv[k2] = u;
        uv[k2 + 1] = dist / texLen;
      } else {
        uv[k2] = off / 8;
        uv[k2 + 1] = dist / 8;
      }
      nrm[k] = 0; nrm[k + 1] = 1; nrm[k + 2] = 0;
    }
  }

  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      // 绕序必须让法线朝上（+Y）。写反的话路面会被背面剔除，
      // 表现为"路面看不见 / 光照全错"，而且只有从下方才看得到。
      idx.push(a, b, c, b, d, c);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** 护栏墙体（垂直面） */
function buildWall(track: Track, side: 1 | -1, height: number): THREE.BufferGeometry {
  return buildWallStripe(track, side, 0, height);
}

/** 护栏上的一条水平色带（y0..y1 高度区间） */
function buildWallStripe(track: Track, side: 1 | -1, y0: number, y1: number): THREE.BufferGeometry {
  const N = track.samples.length;
  const rows = N + 1;
  const pos = new Float32Array(rows * 2 * 3);
  const uv = new Float32Array(rows * 2 * 2);
  const idx: number[] = [];

  for (let i = 0; i < rows; i++) {
    const s = track.samples[i % N];
    const dist = i === N ? track.length : s.dist;
    const off = side * (s.half + SHOULDER);
    const baseY = s.y - Math.sin(s.bank) * off + track.rampLift(dist, off);
    const bx = s.x + s.lx * off;
    const bz = s.z + s.lz * off;
    for (let j = 0; j < 2; j++) {
      const k = (i * 2 + j) * 3;
      pos[k] = bx;
      pos[k + 1] = baseY + (j === 0 ? y0 : y1);
      pos[k + 2] = bz;
      const k2 = (i * 2 + j) * 2;
      // 每 6m 一个围挡色块循环
      uv[k2] = dist / 6;
      uv[k2 + 1] = j;
    }
  }
  for (let i = 0; i < rows - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** 起跑门架 */
function buildGantry(track: Track, accent: number): { obj: THREE.Object3D; disposables: Array<{ dispose(): void }> } {
  const d: Array<{ dispose(): void }> = [];
  const s = track.sampleAt(0);
  const g = new THREE.Group();
  const w = s.half + SHOULDER;
  const legGeo = new THREE.CylinderGeometry(0.5, 0.7, 11, 8);
  const legMat = new THREE.MeshStandardMaterial({ color: 0x141826, roughness: 0.5, metalness: 0.6 });
  const barGeo = new THREE.BoxGeometry(w * 2, 1.5, 1.2);
  const barMat = new THREE.MeshStandardMaterial({ color: 0x0d1020, roughness: 0.5, metalness: 0.5 });
  const glowGeo = new THREE.BoxGeometry(w * 2 - 0.4, 0.35, 1.35);
  const glowMat = new THREE.MeshBasicMaterial({ color: accent, toneMapped: false });
  d.push(legGeo, legMat, barGeo, barMat, glowGeo, glowMat);

  for (const side of [1, -1] as const) {
    const leg = new THREE.Mesh(legGeo, legMat);
    leg.position.set(s.lx * side * w, 5.5, s.lz * side * w);
    g.add(leg);
  }
  const bar = new THREE.Mesh(barGeo, barMat);
  bar.position.y = 10.6;
  g.add(bar);
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.position.y = 9.9;
  g.add(glow);

  g.position.set(s.x, s.y, s.z);
  g.rotation.y = Math.atan2(s.fx, s.fz);
  return { obj: g, disposables: d };
}

/** 沿赛道两侧的霓虹柱：跑起来的"闪过感"主要来自它们 */
function buildNeonPosts(track: Track, colorA: number, colorB: number) {
  const d: Array<{ dispose(): void }> = [];
  const g = new THREE.Group();
  const spacing = 26;
  const count = Math.floor(track.length / spacing);

  const postGeo = new THREE.BoxGeometry(0.35, 3.4, 0.35);
  const matA = new THREE.MeshBasicMaterial({ color: colorA, toneMapped: false });
  const matB = new THREE.MeshBasicMaterial({ color: colorB, toneMapped: false });
  d.push(postGeo, matA, matB);

  const instA = new THREE.InstancedMesh(postGeo, matA, count + 2);
  const instB = new THREE.InstancedMesh(postGeo, matB, count + 2);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const scl = new THREE.Vector3(1, 1, 1);
  let ia = 0, ib = 0;

  for (let i = 0; i < count; i++) {
    const dist = i * spacing;
    const s = track.sampleAt(dist);
    const side: 1 | -1 = i % 2 === 0 ? 1 : -1;
    const off = side * (s.half + SHOULDER - 0.6);
    const y = s.y - Math.sin(s.bank) * off + track.rampLift(dist, off);
    e.set(0, Math.atan2(s.fx, s.fz), 0);
    q.setFromEuler(e);
    m.compose(new THREE.Vector3(s.x + s.lx * off, y + 2.4, s.z + s.lz * off), q, scl);
    if (i % 4 < 2) instA.setMatrixAt(ia++, m); else instB.setMatrixAt(ib++, m);
  }
  instA.count = ia; instB.count = ib;
  instA.instanceMatrix.needsUpdate = true;
  instB.instanceMatrix.needsUpdate = true;
  g.add(instA, instB);
  return { obj: g, disposables: d };
}

/** 主题环境：城市楼群 / 海岸 / 峡谷岩壁 */
function buildEnvironment(track: Track): { obj: THREE.Object3D; disposables: Array<{ dispose(): void }> } {
  const d: Array<{ dispose(): void }> = [];
  const g = new THREE.Group();
  const theme = track.def.theme;
  const rng = mulberry32(track.def.seed ^ 0x5bd1e995);

  // 地面大平面（垫在赛道下方，避免看到虚空）。悬空赛道故意不放。
  if (theme.env !== 'space') {
    const geo = new THREE.PlaneGeometry(6000, 6000);
    const tex = makeGroundTexture(theme.ground);
    tex.repeat.set(200, 200);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1 });
    d.push(geo, tex, mat);
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = -track.def.hillAmp - 14;
    g.add(m);
  }

  if (theme.env === 'space') {
    // 悬空道：路面下方挂一层发光支撑肋 + 远处漂浮的星体
    {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const mat = new THREE.MeshBasicMaterial({ color: 0x6a4fd8, toneMapped: false });
      d.push(geo, mat);
      const spacing = 14;
      const count = Math.floor(track.length / spacing);
      const inst = new THREE.InstancedMesh(geo, mat, count);
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      for (let i = 0; i < count; i++) {
        const dist = i * spacing;
        const s = track.sampleAt(dist);
        q.setFromEuler(new THREE.Euler(0, Math.atan2(s.fx, s.fz), s.bank));
        m4.compose(
          new THREE.Vector3(s.x, s.y - 1.1, s.z), q,
          new THREE.Vector3(s.half * 2.1, 1.1, 2.6),
        );
        inst.setMatrixAt(i, m4);
      }
      inst.instanceMatrix.needsUpdate = true;
      g.add(inst);
    }
    // 漂浮星体
    {
      const geo = new THREE.IcosahedronGeometry(1, 0);
      const mat = new THREE.MeshStandardMaterial({
        color: 0x2a2050, emissive: 0x8b5cff, emissiveIntensity: 0.6, roughness: 0.5, flatShading: true,
      });
      d.push(geo, mat);
      const N = 90;
      const inst = new THREE.InstancedMesh(geo, mat, N);
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      let n = 0;
      for (let i = 0; i < N * 3 && n < N; i++) {
        const dist = rng() * track.length;
        const s = track.sampleAt(dist);
        const side = rng() < 0.5 ? 1 : -1;
        const off = side * (s.half + 90 + rng() * 260);
        // 别和赛道齐平，否则会像一堵墙糊在镜头前
        const dy = (rng() < 0.5 ? -1 : 1) * (35 + rng() * 90);
        const r = 6 + rng() * 18;
        q.setFromEuler(new THREE.Euler(rng() * TAU, rng() * TAU, rng() * TAU));
        m4.compose(
          new THREE.Vector3(s.x + s.lx * off, s.y + dy, s.z + s.lz * off),
          q, new THREE.Vector3(r, r, r),
        );
        inst.setMatrixAt(n++, m4);
      }
      inst.count = n;
      inst.instanceMatrix.needsUpdate = true;
      g.add(inst);
    }
  } else if (theme.env === 'city') {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const tex = makeBuildingTexture();
    const mat = new THREE.MeshStandardMaterial({
      map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.9,
      color: 0x0a0c18, roughness: 0.85,
    });
    d.push(geo, tex, mat);
    const N = 200;
    const inst = new THREE.InstancedMesh(geo, mat, N);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    let n = 0;
    for (let i = 0; i < N * 3 && n < N; i++) {
      const dist = rng() * track.length;
      const s = track.sampleAt(dist);
      const side = rng() < 0.5 ? 1 : -1;
      const off = side * (s.half + SHOULDER + 55 + rng() * 190);
      const x = s.x + s.lx * off, z = s.z + s.lz * off;
      const w = 14 + rng() * 26;
      const h = 30 + rng() * 110;
      q.setFromEuler(new THREE.Euler(0, rng() * TAU, 0));
      m4.compose(new THREE.Vector3(x, s.y - 8 + h / 2, z), q, new THREE.Vector3(w, h, w * (0.7 + rng() * 0.6)));
      inst.setMatrixAt(n++, m4);
    }
    inst.count = n;
    inst.instanceMatrix.needsUpdate = true;
    g.add(inst);
  } else if (theme.env === 'coast') {
    // 海面
    const geo = new THREE.PlaneGeometry(7000, 7000, 1, 1);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0d4d6b, roughness: 0.16, metalness: 0.75, transparent: true, opacity: 0.94,
    });
    d.push(geo, mat);
    const sea = new THREE.Mesh(geo, mat);
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = -track.def.hillAmp - 9;
    sea.name = 'sea';
    g.add(sea);

    // 棕榈（圆柱 + 锥）
    const trunkGeo = new THREE.CylinderGeometry(0.35, 0.6, 9, 6);
    const leafGeo = new THREE.ConeGeometry(3.4, 3.2, 6);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3421, roughness: 0.9 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x1f8f5a, roughness: 0.8 });
    d.push(trunkGeo, leafGeo, trunkMat, leafMat);
    const N = 110;
    const it = new THREE.InstancedMesh(trunkGeo, trunkMat, N);
    const il = new THREE.InstancedMesh(leafGeo, leafMat, N);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    let n = 0;
    for (let i = 0; i < N * 2 && n < N; i++) {
      const dist = rng() * track.length;
      const s = track.sampleAt(dist);
      const side = rng() < 0.5 ? 1 : -1;
      const off = side * (s.half + SHOULDER + 6 + rng() * 40);
      const x = s.x + s.lx * off, z = s.z + s.lz * off;
      q.setFromEuler(new THREE.Euler(rng() * 0.14, rng() * TAU, rng() * 0.14));
      m4.compose(new THREE.Vector3(x, s.y + 3.6, z), q, one);
      it.setMatrixAt(n, m4);
      m4.compose(new THREE.Vector3(x, s.y + 9.2, z), q, one);
      il.setMatrixAt(n, m4);
      n++;
    }
    it.count = il.count = n;
    it.instanceMatrix.needsUpdate = true;
    il.instanceMatrix.needsUpdate = true;
    g.add(it, il);
  } else {
    // 峡谷：赛道两侧拉起岩壁
    const rockTex = makeRockTexture(theme.ground);
    d.push(rockTex);
    for (const side of [1, -1] as const) {
      const geo = buildCanyonWall(track, side, rng);
      const mat = new THREE.MeshStandardMaterial({
        map: rockTex, color: 0xffffff, roughness: 0.95, metalness: 0,
        side: THREE.DoubleSide, envMapIntensity: 0.45,
      });
      d.push(geo, mat);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      g.add(mesh);
    }
  }

  return { obj: g, disposables: d };
}

/**
 * 峡谷岩壁。
 *
 * 之前每个采样点各自取一个独立随机数当高度噪声，相邻两行的顶层高度能差出 34 个单位，
 * 于是山脊变成一排锯齿尖刺，远看像撕碎的纸。这里改成沿赛道方向平滑过的噪声：
 * 先取随机序列，再做几轮环形均值模糊（必须环形，赛道是闭环，否则接缝处会有台阶），
 * 叠一层低频正弦做大尺度起伏，得到连绵的山脊线。
 */
function buildCanyonWall(track: Track, side: 1 | -1, rng: () => number): THREE.BufferGeometry {
  const N = track.samples.length;
  const rows = N + 1;
  const LAYERS = 6;
  const pos = new Float32Array(rows * LAYERS * 3);
  const uv = new Float32Array(rows * LAYERS * 2);
  const idx: number[] = [];

  // 环形平滑噪声
  let noise = new Array(N).fill(0).map(() => rng());
  for (let pass = 0; pass < 4; pass++) {
    const next = new Array(N);
    for (let i = 0; i < N; i++) {
      const a = noise[(i - 2 + N) % N], b = noise[(i - 1 + N) % N];
      const c = noise[i];
      const dd = noise[(i + 1) % N], e = noise[(i + 2) % N];
      next[i] = (a + b * 2 + c * 3 + dd * 2 + e) / 9;
    }
    noise = next;
  }
  // 平滑之后方差会塌掉，重新拉开对比，再叠两层低频起伏做山体轮廓
  const phase = rng() * Math.PI * 2;
  const shaped = noise.map((v, i) => {
    const t = (i / N) * Math.PI * 2;
    const macro = Math.sin(t * 3 + phase) * 0.5 + Math.sin(t * 7 + phase * 2) * 0.25;
    return clampNum((v - 0.5) * 3.2 + 0.5 + macro * 0.45, 0, 1);
  });

  let vDist = 0;
  for (let i = 0; i < rows; i++) {
    const s = track.samples[i % N];
    if (i > 0) {
      const p = track.samples[(i - 1) % N];
      vDist += Math.hypot(s.x - p.x, s.z - p.z);
    }
    const base = s.half + SHOULDER + 1;
    const nz = shaped[i % N];
    const heights = [0, 4 + nz * 4, 11 + nz * 11, 20 + nz * 20, 32 + nz * 28, 44 + nz * 38];
    const widths = [base, base + 2 + nz * 2, base + 6 + nz * 5, base + 13 + nz * 8,
      base + 22 + nz * 12, base + 34 + nz * 18];
    for (let j = 0; j < LAYERS; j++) {
      const off = side * widths[j];
      const k = (i * LAYERS + j) * 3;
      pos[k] = s.x + s.lx * off;
      pos[k + 1] = s.y - 1 + heights[j];
      pos[k + 2] = s.z + s.lz * off;
      const u = (i * LAYERS + j) * 2;
      uv[u] = vDist / 34;
      uv[u + 1] = heights[j] / 34;
    }
  }
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < LAYERS - 1; j++) {
      const a = i * LAYERS + j, b = a + 1, c = a + LAYERS, dd = c + 1;
      idx.push(a, c, b, b, c, dd);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

