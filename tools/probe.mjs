/**
 * 自动化运行时探针 —— 画面/物理问题的"真执行引擎"。
 *
 * 存在的理由：像"车卡在路里""胎印只剩一条"这类问题，靠截图肉眼看只能猜，
 * 改完还得再截一张再猜。这个工具把它们变成**数字**：跑一局真实比赛，
 * 每帧采样几何关系，输出 min/p1/均值，并按阈值判定 PASS/FAIL。
 * 改完代码重跑一次就知道到底修没修好，不用来回问。
 *
 * 为什么要自己起 Chromium：VS Code 内嵌浏览器把页面标记为 hidden，
 * rAF 停摆；而且 WebGL compositor 被限制在真实窗口尺寸。见 shoot.mjs 顶部注释。
 *
 * 用法：
 *   node tools/probe.mjs                          # 默认 city 赛道，5 名 AI，跑 20 秒
 *   node tools/probe.mjs --track 3 --secs 30
 *   node tools/probe.mjs --url http://localhost:5180/
 *   node tools/probe.mjs --json tmp/probe.json    # 额外落盘，便于前后对比
 *
 * 退出码：全部 PASS = 0，有 FAIL = 1（可直接接进 CI / 部署前门禁）
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const URL_ = arg('url', 'https://qlili.com/speed/');
const TRACK = Number(arg('track', '1'));
const AI = Number(arg('ai', '3'));      // 1=无 2=3名 3=5名 4=7名
const SECS = Number(arg('secs', '20'));
const JSON_OUT = arg('json', '');

/** 判定阈值。改这里等于改"什么叫做对了" */
const THRESHOLDS = {
  // 车体参考平面（≈轮胎接地面）任何一个角都不该沉到路面以下。
  // 为什么不是 0：
  //  - 路面网格是折线逼近曲面，采样点之间本来就有 ~1cm 的弦高误差；
  //  - 探针用无 hint 的 surfaceHeight（全局最近点），物理用带 hint 的（沿当前赛道段）。
  //    在发卡弯/赛道自身靠得近的地方两者会选到不同路段，实测差到 ~10cm，
  //    而那种地方物理的答案其实更对 —— 车确实在它正开的那段路上。
  // 历史基线：修复前 min=-0.65m / p50=-0.22m，那是肉眼可见的"车陷在路里"。
  chassisGapMin: -0.10,
  // 两侧胎印必须都在。横向偏移的两簇中心应该分列 0 两侧且间距 > 1.2m
  skidSideSeparation: 1.2,
  skidMinPerSide: 4,
};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-frame-rate-limit', '--hide-scrollbars'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text().slice(0, 200)); });

console.log(`probe: ${URL_}  track=${TRACK} ai=${AI} secs=${SECS}`);

await page.goto(URL_, { waitUntil: 'load' });
await page.waitForSelector('#btn-start', { timeout: 30000 });
await page.evaluate(([t, ai]) => {
  document.querySelector(`#track-picker .chip:nth-child(${t})`)?.click();
  document.querySelector(`#ai-picker .chip:nth-child(${ai})`)?.click();
  document.getElementById('btn-start').click();
}, [TRACK, AI]);
await page.waitForFunction(() => window.__neon?.race, null, { timeout: 150000 });

// ---- 装钩子 + 同步驱动物理 ------------------------------------------------
// 关键：不能靠 rAF 跑。SwiftShader 软渲染下这个场景只有 ~5 fps，
// GameLoop 每帧最多补 MAX_SUBSTEPS=6 步，实测只跑到实时的 8%，
// 20 秒真实时间连倒计时都数不完。
// 所以把 step/render 抢过来自己同步循环 —— 不画像素，只推物理和场景图，
// 几何断言本来也不需要 GPU。顺带得到完全确定性的结果。
const S = await page.evaluate(async ({ secs }) => {
  const race = window.__neon.race;
  const track = race.track;
  race.autopilot = true;

  const S = {
    steps: 0,
    chassisGap: [],
    chassisGapOn: [],   // 赛道内
    chassisGapOff: [],  // 路肩/草地，地形本来就崎岖
    chassisWorst: { gap: 1e9, corner: null, pitch: 0, roll: 0, speed: 0, slope: 0 },
    skid: [],
    bumps: [],
    maxSpeed: 0,
  };

  const CORNERS = [[-0.95, -2.0], [0.95, -2.0], [-0.95, 2.0], [0.95, 2.0]];
  const scratch = window.__neon.stage.scene.position.clone();

  // 胎印：包一层 addSegment，记下每段相对最近那辆车的横向偏移。
  // 两侧正常时应聚成 ±1.08 附近两簇；退化成一条时只剩一簇。
  const skidObj = race.effects.skid;
  const origAdd = skidObj.addSegment.bind(skidObj);
  skidObj.addSegment = (from, to, w, op) => {
    let best = null, bestD2 = 1e9;
    for (const r of race.racers) {
      const k = r.kart;
      const d2 = (k.x - from.x) ** 2 + (k.z - from.z) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = k; }
    }
    if (best && bestD2 < 25) {
      // 右向量 = (cos h, -sin h)
      const ch = Math.cos(best.heading), sh = Math.sin(best.heading);
      S.skid.push(+((from.x - best.x) * ch + (from.z - best.z) * -sh).toFixed(3));
    }
    return origAdd(from, to, w, op);
  };

  // 碰撞：记录每次接触带来的速度突变，用来量"撞飞感"
  const prevV = new Map();
  const origResolve = race.resolveKartCollisions.bind(race);
  race.resolveKartCollisions = () => {
    prevV.clear();
    for (const r of race.racers) prevV.set(r.id, { vx: r.kart.vx, vz: r.kart.vz, vy: r.kart.vy });
    origResolve();
    for (const r of race.racers) {
      const p = prevV.get(r.id), k = r.kart;
      const dv = Math.hypot(k.vx - p.vx, k.vz - p.vz, k.vy - p.vy);
      if (dv > 0.5) S.bumps.push(+dv.toFixed(2));
    }
  };

  const origStep = race.step.bind(race);
  const origRender = race.render.bind(race);
  race.step = () => {};      // 让页面自己的 rAF 循环空转
  race.render = () => {};

  const IDLE = {
    throttle: 0, brake: 0, steer: 0, drift: false, driftPressed: false,
    driftReleased: false, nitroPressed: false, resetPressed: false, lookBack: false,
  };
  const DT = 1 / 120;
  const total = Math.round(secs / DT);

  const sample = () => {
    const r = race.racers.find((x) => x.isPlayer) || race.racers[0];
    const root = r.visual?.root;
    if (!root) return;
    root.updateMatrixWorld(true);
    let worst = 1e9, worstCorner = null;
    for (const [lx, lz] of CORNERS) {
      const v = scratch.clone().set(lx, 0, lz);
      root.localToWorld(v);
      const gap = v.y - track.surfaceHeight(v.x, v.z).y;
      if (gap < worst) { worst = gap; worstCorner = [lx, lz]; }
    }
    S.chassisGap.push(worst);
    if (r.kart.offroad) S.chassisGapOff.push(worst); else S.chassisGapOn.push(worst);
    S.maxSpeed = Math.max(S.maxSpeed, r.kart.speed);
    if (worst < S.chassisWorst.gap) {
      const k = r.kart;
      // 完整分解：出问题时要能一眼看出是抬升没算够、还是采样点对不上
      const perCorner = CORNERS.map(([lx, lz]) => {
        const v = scratch.clone().set(lx, 0, lz);
        root.localToWorld(v);
        return {
          c: [lx, lz],
          y: +v.y.toFixed(3),
          surfNoHint: +track.surfaceHeight(v.x, v.z).y.toFixed(3),
          surfHint: +track.surfaceHeight(v.x, v.z, k.trackIndex).y.toFixed(3),
        };
      });
      S.chassisWorst = {
        gap: +worst.toFixed(4), corner: worstCorner,
        groundRoll: +(k.groundRoll ?? 0).toFixed(4), bodyRoll: +(k.bodyRoll ?? 0).toFixed(4),
        groundPitch: +(k.groundPitch ?? 0).toFixed(4), bodyPitch: +(k.bodyPitch ?? 0).toFixed(4),
        recoil: +(k.impactRecoil ?? 0).toFixed(3), grounded: k.grounded,
        lift: +(k.groundLift ?? 0).toFixed(4), rootY: +root.position.y.toFixed(3),
        kartY: +k.y.toFixed(3), speed: +k.speed.toFixed(1),
        offroad: k.offroad, spinOut: +(k.spinOut ?? 0).toFixed(2),
        perCorner,
      };
    }
  };

  for (let i = 0; i < total; i++) {
    origStep(DT, IDLE, true);
    S.steps++;
    // 场景图每 4 个物理步更新一次就够采样了，省时间
    if (i % 4 === 0) { origRender(0, DT * 4); sample(); }
    // 每 3000 步让出一次事件循环，避免长任务被判定为无响应
    if (i % 3000 === 2999) await new Promise((r) => setTimeout(r, 0));
  }

  const g = S.chassisGap.slice().sort((a, b) => a - b);
  const pct = (p) => (g.length ? +g[Math.floor(p * (g.length - 1))].toFixed(4) : 0);
  const minOf = (a) => (a.length ? +Math.min(...a).toFixed(4) : 0);
  const left = S.skid.filter((v) => v < 0), right = S.skid.filter((v) => v > 0);
  const avg = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3) : 0);
  return {
    steps: S.steps, simSeconds: +(S.steps / 120).toFixed(1), maxSpeed: +S.maxSpeed.toFixed(1),
    state: race.state,
    chassis: { min: pct(0), p1: pct(0.01), p50: pct(0.5), samples: g.length, worst: S.chassisWorst,
      minOnTrack: minOf(S.chassisGapOn), minOffroad: minOf(S.chassisGapOff),
      onTrackSamples: S.chassisGapOn.length, offroadSamples: S.chassisGapOff.length },
    skid: { total: S.skid.length, left: left.length, right: right.length, leftAvg: avg(left), rightAvg: avg(right) },
    bumps: {
      count: S.bumps.length,
      max: S.bumps.length ? Math.max(...S.bumps) : 0,
      avg: S.bumps.length ? +(S.bumps.reduce((a, b) => a + b, 0) / S.bumps.length).toFixed(2) : 0,
    },
  };
}, { secs: SECS });

await browser.close();

// ---- 判定 ----------------------------------------------------------------
const sep = S.skid.rightAvg - S.skid.leftAvg;
const checks = [
  ['底盘不陷入路面', S.chassis.min >= THRESHOLDS.chassisGapMin,
    `min=${S.chassis.min}m p1=${S.chassis.p1} p50=${S.chassis.p50}  [道内 ${S.chassis.minOnTrack} / 道外 ${S.chassis.minOffroad}]`],
  ['胎印左右两条都在', S.skid.left >= THRESHOLDS.skidMinPerSide && S.skid.right >= THRESHOLDS.skidMinPerSide,
    `left=${S.skid.left}段@${S.skid.leftAvg}m  right=${S.skid.right}段@${S.skid.rightAvg}m`],
  ['胎印左右分得开', sep >= THRESHOLDS.skidSideSeparation, `间距=${sep.toFixed(2)}m (阈值 >= ${THRESHOLDS.skidSideSeparation})`],
  ['比赛真的跑起来了', S.state === 'racing' && S.maxSpeed > 20, `state=${S.state} 模拟${S.simSeconds}s 最高速${S.maxSpeed}`],
  ['无运行时报错', pageErrors.length === 0, pageErrors.length ? pageErrors[0] : 'none'],
];

console.log('');
let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(18)} ${detail}`);
}
console.log('');
console.log(`  碰撞 ${S.bumps.count} 次，速度突变 均值 ${S.bumps.avg} 峰值 ${S.bumps.max} m/s`);
if (S.chassis.worst.corner) {
  const w = S.chassis.worst;
  console.log('  最差底盘间隙分解: ' + JSON.stringify(S.chassis.worst));
}

if (JSON_OUT) {
  const f = resolve(JSON_OUT);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ ...S, pageErrors }, null, 2));
  console.log(`  -> ${f}`);
}
process.exit(failed ? 1 : 0);
