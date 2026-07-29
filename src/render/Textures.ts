import * as THREE from 'three';

/** 所有贴图都在运行时用 Canvas 画出来 —— 项目零外部素材依赖，方便部署 */

function canvas(w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  return { c, g };
}

function hex(n: number): string {
  return '#' + n.toString(16).padStart(6, '0');
}

/** 沥青路面：噪点 + 两侧边线 + 中央虚线。U 横向，V 沿赛道 */
export function makeRoadTexture(road: number, edge: number, rainbow = false): THREE.Texture {
  const W = 512, H = 512;
  const { c, g } = canvas(W, H);

  if (rainbow) {
    // 彩虹之路：色带沿赛道方向（V）排列，跑起来是一段段颜色迎面掠过
    const bands = ['#ff3b6b', '#ff9b1f', '#ffd23f', '#35f5a0', '#22e6ff', '#8b5cff'];
    const bh = H / bands.length;
    for (let i = 0; i < bands.length; i++) {
      g.fillStyle = bands[i];
      g.fillRect(0, i * bh, W, bh + 1);
    }
    // 色带之间的发光分隔线
    g.fillStyle = 'rgba(255,255,255,0.85)';
    for (let i = 0; i < bands.length; i++) g.fillRect(0, i * bh, W, 4);
    // 两侧边缘白光
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.fillRect(0, 0, W * 0.028, H);
    g.fillRect(W * 0.972, 0, W * 0.028, H);
    // 中央暗色分道，强化"两车道"感
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.fillRect(W * 0.49, 0, W * 0.02, H);

    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  g.fillStyle = hex(road);
  g.fillRect(0, 0, W, H);

  // 沥青颗粒
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 26;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);

  // 深浅不一的沥青斑块（新旧铺装的色差）
  for (let i = 0; i < 22; i++) {
    g.globalAlpha = 0.03 + Math.random() * 0.05;
    g.fillStyle = Math.random() < 0.5 ? '#000' : '#fff';
    const w = 40 + Math.random() * 180;
    const h = 30 + Math.random() * 150;
    g.fillRect(Math.random() * W, Math.random() * H, w, h);
  }
  g.globalAlpha = 1;

  // 修补痕：颜色略深的不规则块 + 轮廓
  for (let i = 0; i < 5; i++) {
    const x = Math.random() * W, y = Math.random() * H;
    const w = 50 + Math.random() * 90, h = 26 + Math.random() * 50;
    g.fillStyle = 'rgba(0,0,0,0.16)';
    g.fillRect(x, y, w, h);
    g.strokeStyle = 'rgba(0,0,0,0.26)';
    g.lineWidth = 2;
    g.strokeRect(x, y, w, h);
  }

  // 轮胎痕：沿行进方向的深色双条，赛道“被跑过”的感觉全靠它
  for (const lane of [0.3, 0.42, 0.58, 0.7]) {
    if (Math.random() < 0.35) continue;
    g.strokeStyle = 'rgba(0,0,0,0.2)';
    g.lineWidth = 7 + Math.random() * 5;
    g.beginPath();
    const x = W * lane + (Math.random() - 0.5) * 20;
    g.moveTo(x, 0);
    g.bezierCurveTo(x + 18, H * 0.33, x - 18, H * 0.66, x, H);
    g.stroke();
  }

  // 横向拼接缝（每隔一段一条深色接缝，增强速度感）
  g.strokeStyle = 'rgba(0,0,0,0.28)';
  g.lineWidth = 3;
  for (let i = 0; i < 4; i++) {
    const y = (i + 0.5) * (H / 4);
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
  }

  // 两侧白色实线
  g.fillStyle = 'rgba(240,246,255,0.88)';
  g.fillRect(W * 0.022, 0, W * 0.018, H);
  g.fillRect(W * 0.96, 0, W * 0.018, H);

  // 边线内侧的霓虹色带
  g.fillStyle = hex(edge) + 'aa';
  g.fillRect(W * 0.046, 0, W * 0.01, H);
  g.fillRect(W * 0.944, 0, W * 0.01, H);

  // 中央虚线
  g.fillStyle = 'rgba(255,255,255,0.62)';
  const dash = H / 6;
  for (let i = 0; i < 6; i++) {
    if (i % 2 === 0) g.fillRect(W * 0.492, i * dash, W * 0.016, dash * 0.6);
  }

  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * 路缘石（curb）—— 红白相间的斜条。
 * 这是赛道最标志性的视觉元素，有了它一眼就知道“这是赛道”而不是一条普通的路。
 * UV 约定：u 横向 0..1，v 沿赛道（每个重复周期 = 一组红白）。
 */
export function makeCurbTexture(warm = 0xd8443a, cool = 0xf2f4f8): THREE.Texture {
  const W = 96, H = 256;
  const { c, g } = canvas(W, H);
  g.fillStyle = hex(cool);
  g.fillRect(0, 0, W, H);
  g.fillStyle = hex(warm);
  g.fillRect(0, 0, W, H / 2);

  // 磨损：边缘蹭脏一点，不那么塑料
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 30;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);

  // 内侧阴影，让路缘石看起来有厚度
  const grad = g.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0.35)');
  grad.addColorStop(0.35, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * 赛道围挡（护栏）—— 交替色块 + 上下边条。
 * 纯色护栏跑起来像一堵墙，有了节奏感的色块才像赛道。
 */
export function makeBarrierTexture(accent: number, alt: number): THREE.Texture {
  const W = 128, H = 32;
  const { c, g } = canvas(W, H);
  g.fillStyle = '#12151f';
  g.fillRect(0, 0, W, H);

  // 中间一排交替色块。
  // 之前 alpha 0.85 的高饱和红/黄大格子在画面里比赛道还抢眼，
  // 一整圈护栏像一条闪烁的糖果带。压低透明度并混一点底色，让它退到背景里去。
  const blocks = 4;
  const bw = W / blocks;
  const base = new THREE.Color(0x12151f);
  for (let i = 0; i < blocks; i++) {
    const c2 = new THREE.Color(i % 2 === 0 ? accent : alt).lerp(base, 0.42);
    g.fillStyle = `#${c2.getHexString()}`;
    g.globalAlpha = 0.62;
    g.fillRect(i * bw + 3, H * 0.32, bw - 6, H * 0.36);
  }
  g.globalAlpha = 1;

  // 上下边条
  g.fillStyle = 'rgba(210,222,240,0.34)';
  g.fillRect(0, 0, W, 2);
  g.fillRect(0, H - 3, W, 3);

  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 起跑线棋盘格 */
export function makeStartLineTexture(): THREE.Texture {
  const N = 128;
  const { c, g } = canvas(N, N);
  const cells = 8;
  const s = N / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      g.fillStyle = (x + y) % 2 === 0 ? '#f2f6ff' : '#12141c';
      g.fillRect(x * s, y * s, s, s);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.repeat.set(14, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 加速带：箭头 */
export function makeBoostPadTexture(color: number): THREE.Texture {
  const W = 128, H = 256;
  const { c, g } = canvas(W, H);
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(0, 0, W, H);
  g.fillStyle = hex(color);
  g.shadowColor = hex(color);
  g.shadowBlur = 18;
  for (let i = 0; i < 3; i++) {
    const y = H * (0.2 + i * 0.28);
    g.beginPath();
    g.moveTo(W * 0.5, y - H * 0.11);
    g.lineTo(W * 0.88, y + H * 0.04);
    g.lineTo(W * 0.66, y + H * 0.04);
    g.lineTo(W * 0.66, y + H * 0.11);
    g.lineTo(W * 0.34, y + H * 0.11);
    g.lineTo(W * 0.34, y + H * 0.04);
    g.lineTo(W * 0.12, y + H * 0.04);
    g.closePath();
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 草地 / 路肩 */
export function makeGroundTexture(base: number): THREE.Texture {
  const N = 256;
  const { c, g } = canvas(N, N);
  g.fillStyle = hex(base);
  g.fillRect(0, 0, N, N);
  const img = g.getImageData(0, 0, N, N);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 34;
    d[i] = Math.max(0, d[i] + n);
    d[i + 1] = Math.max(0, d[i + 1] + n * 1.2);
    d[i + 2] = Math.max(0, d[i + 2] + n * 0.7);
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(60, 60);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 天空渐变（贴到反面球体上） */
export function makeSkyTexture(top: number, bottom: number, env: string): THREE.Texture {
  const W = 32, H = 256;
  const { c, g } = canvas(W, H);
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, hex(top));
  grad.addColorStop(0.52, hex(top));
  grad.addColorStop(1, hex(bottom));
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  if (env === 'city') {
    // 星星
    g.fillStyle = 'rgba(255,255,255,0.85)';
    for (let i = 0; i < 90; i++) {
      const y = Math.random() * H * 0.55;
      g.globalAlpha = 0.25 + Math.random() * 0.7;
      g.fillRect(Math.random() * W, y, 1, 1);
    }
    g.globalAlpha = 1;
  } else if (env === 'space') {
    // 密集星场 + 星云，铺满整个球
    for (let i = 0; i < 420; i++) {
      g.globalAlpha = 0.2 + Math.random() * 0.8;
      const s = Math.random() < 0.9 ? 1 : 2;
      g.fillStyle = Math.random() < 0.8 ? '#ffffff' : '#9fd0ff';
      g.fillRect(Math.random() * W, Math.random() * H, s, s);
    }
    g.globalAlpha = 0.16;
    for (const [col, cy] of [['#8b5cff', 0.34], ['#ff2fb9', 0.62], ['#22e6ff', 0.5]] as const) {
      const grd = g.createRadialGradient(W / 2, H * cy, 0, W / 2, H * cy, H * 0.22);
      grd.addColorStop(0, col);
      grd.addColorStop(1, 'transparent');
      g.fillStyle = grd;
      g.fillRect(0, 0, W, H);
    }
    g.globalAlpha = 1;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
}

/** 圆形柔光点（尾焰/火花/光晕的 sprite） */
/**
 * 车头灯打在路面上的光斑。
 *
 * 用贴片而不是真 SpotLight：一局最多 8 台车，8 盏带衰减的聚光灯在移动端直接跪，
 * 而夜景赛车里玩家真正感知到的其实就是"车前方地面被照亮的那一块"。
 * 贴片是梯形渐变——近车头宽而亮，往前收窄并淡出，两侧留软边。
 */
export function makeHeadlightTexture(): THREE.Texture {
  const W = 128, H = 256;
  const { c, g } = canvas(W, H);
  g.clearRect(0, 0, W, H);
  // v=0 在贴片近端（车头），v=1 在远端
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    // 远端淡出：先亮一段再衰减，避免车头正下方一个突兀的硬边
    const falloff = Math.pow(1 - t, 1.7) * (t < 0.08 ? t / 0.08 : 1);
    // 光锥往前张开
    const halfW = (0.12 + t * 0.42) * W;
    const grad = g.createLinearGradient(W / 2 - halfW, 0, W / 2 + halfW, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, `rgba(255,252,235,${(falloff * 0.85).toFixed(3)})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, y, W, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * 峡谷岩壁。横向沉积岩层 + 纵向水蚀条纹。
 * 纯色岩壁在画面里就是一大片死褐色，加了岩层之后才有体积和尺度感。
 */
export function makeRockTexture(base: number): THREE.Texture {
  const N = 256;
  const { c, g } = canvas(N, N);
  const col = new THREE.Color(base);
  g.fillStyle = `#${col.getHexString()}`;
  g.fillRect(0, 0, N, N);

  // 沉积岩层：粗细不一的水平色带。这是岩壁唯一的主要特征。
  // 之前还画了一批纵向侵蚀条纹，但岩壁面是斜的、UV 沿赛道拉得很长，
  // 那些条纹被拉成横贯整面墙的斜划痕，看着像铅笔涂鸦。
  let y = 0;
  while (y < N) {
    const h = 4 + Math.random() * 20;
    const shade = 0.70 + Math.random() * 0.55;
    const c2 = col.clone().multiplyScalar(shade);
    g.fillStyle = `#${c2.getHexString()}`;
    g.fillRect(0, y, N, h);
    // 岩层下沿的阴影线，制造层与层之间的厚度
    g.fillStyle = 'rgba(0,0,0,0.26)';
    g.fillRect(0, y + h - 1, N, 2);
    // 层内再嵌几块碎岩，打断纯色带
    for (let i = 0; i < 6; i++) {
      const bw = 8 + Math.random() * 40;
      const bh = Math.max(2, h * (0.3 + Math.random() * 0.5));
      g.fillStyle = `rgba(0,0,0,${(Math.random() * 0.12).toFixed(3)})`;
      g.fillRect(Math.random() * N, y + Math.random() * (h - bh), bw, bh);
    }
    y += h;
  }

  // 颗粒感，避免大面积死板
  for (let i = 0; i < 2600; i++) {
    const bright = Math.random() < 0.5;
    g.fillStyle = bright
      ? `rgba(255,236,210,${(Math.random() * 0.07).toFixed(3)})`
      : `rgba(0,0,0,${(Math.random() * 0.08).toFixed(3)})`;
    g.fillRect(Math.random() * N, Math.random() * N, 2, 2);
  }

  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function makeGlowTexture(): THREE.Texture {
  const N = 128;
  const { c, g } = canvas(N, N);
  const grad = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.75)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.22)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, N, N);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 星形火花 */
export function makeSparkTexture(): THREE.Texture {
  const N = 64;
  const { c, g } = canvas(N, N);
  g.translate(N / 2, N / 2);
  g.fillStyle = '#fff';
  g.shadowColor = '#fff';
  g.shadowBlur = 10;
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const r = i % 2 === 0 ? N * 0.46 : N * 0.13;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 建筑立面（发光窗格） */
export function makeBuildingTexture(): THREE.Texture {
  const W = 64, H = 128;
  const { c, g } = canvas(W, H);
  g.fillStyle = '#080a16';
  g.fillRect(0, 0, W, H);
  const colors = ['#22e6ff', '#ff2fb9', '#ffd23f', '#8b5cff', '#35f5a0'];
  for (let y = 3; y < H - 4; y += 8) {
    for (let x = 3; x < W - 4; x += 8) {
      if (Math.random() < 0.42) {
        g.fillStyle = colors[(Math.random() * colors.length) | 0];
        g.globalAlpha = 0.35 + Math.random() * 0.65;
        g.fillRect(x, y, 4, 5);
      }
    }
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
