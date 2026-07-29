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
