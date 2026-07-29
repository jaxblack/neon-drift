/**
 * 画面迭代用的截图工具。
 *
 * VS Code 内嵌浏览器有两个坑，导致没法直接用它评估画面：
 *   1) 页面被标记为 hidden，requestAnimationFrame 停摆，游戏卡在"赛道生成中…"
 *   2) WebGL 的 compositor surface 被限制在真实窗口尺寸（那个面板只有 475x128），
 *      即使把 canvas 撑到 1280x720，截出来也只有左上角一小块是真的
 * 所以这里自己起一个 Chromium，用真实视口渲染，拿到干净的 16:9 截图。
 *
 * 用法：
 *   node tools/shoot.mjs --out tmp/shots --shots "1:city,3:canyon,5:rainbow"
 *   node tools/shoot.mjs --shots "1:closeup" --mode closeup
 *   node tools/shoot.mjs --url http://localhost:5180/
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const URL_ = arg('url', 'https://qlili.com/speed/');
const OUT = arg('out', 'tmp/shots');
const MODE = arg('mode', 'race'); // race | closeup | topdown
const WAIT = Number(arg('wait', '10'));
const AI = arg('ai', '3'); // 第几个 chip：1=无 2=3名 3=5名 4=7名
const W = Number(arg('w', '1600'));
const H = Number(arg('h', '900'));
const SHOTS = arg('shots', '1:city')
  .split(',')
  .map((s) => {
    const [track, name] = s.split(':');
    return { track: Number(track), name: name || `track${track}` };
  });

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-frame-rate-limit',
    '--hide-scrollbars',
  ],
});
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

page.on('pageerror', (e) => console.error('  [pageerror]', String(e).slice(0, 200)));

for (const shot of SHOTS) {
  const file = resolve(`${OUT}/${shot.name}.png`);
  mkdirSync(dirname(file), { recursive: true });
  try {
    await page.goto(URL_, { waitUntil: 'load' });
    await page.waitForSelector('#btn-start', { timeout: 20000 });
    await page.evaluate(
      ([t, ai]) => {
        document.querySelector(`#track-picker .chip:nth-child(${t})`)?.click();
        document.querySelector(`#ai-picker .chip:nth-child(${ai})`)?.click();
        document.getElementById('btn-start').click();
      },
      [shot.track, Number(AI)],
    );
    await page.waitForFunction(() => window.__neon?.race, null, { timeout: 40000 });
    await page.evaluate(() => {
      window.__neon.race.autopilot = true;
    });
    await page.waitForTimeout(WAIT * 1000);

    await page.evaluate((mode) => {
      document.getElementById('hud')?.classList.add('hidden');
      if (mode === 'race') return;
      const st = window.__neon.stage;
      const race = window.__neon.race;
      const k = (race.racers.find((x) => x.kart.drifting) || race.racers[0]).kart;
      // 冻结物理，否则等截图时车已经跑走，相机对着空气
      race.step = () => {};
      race.update = () => {};
      st.updateCamera = () => {};
      const bx = Math.sin(k.heading);
      const bz = Math.cos(k.heading);
      const cam = st.camera;
      cam.rotation.z = 0;
      if (mode === 'closeup') {
        const rx = Math.cos(k.heading);
        const rz = -Math.sin(k.heading);
        cam.position.set(k.x - bx * 6.5 + rx * 4.5, k.y + 2.3, k.z - bz * 6.5 + rz * 4.5);
        cam.fov = 40;
        cam.updateProjectionMatrix();
        cam.lookAt(k.x, k.y + 0.7, k.z);
      } else if (mode === 'topdown') {
        cam.position.set(k.x - bx * 15, k.y + 9, k.z - bz * 15);
        cam.fov = 60;
        cam.updateProjectionMatrix();
        cam.lookAt(k.x - bx * 5, k.y, k.z - bz * 5);
      }
    }, MODE);
    await page.waitForTimeout(700);
    // 不用 page.screenshot：它会先等字体加载，在这个页面上经常卡住 30s 超时。
    // 直接在同一个任务里强制渲一帧再读 WebGL 缓冲，又快又稳。
    const dataUrl = await page.evaluate(() => {
      const st = window.__neon.stage;
      const r = st.renderer;
      st.composer ? st.composer.render() : r.render(st.scene, st.camera);
      return r.domElement.toDataURL('image/png');
    });
    writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    const fps = await page.evaluate(() => window.__neon?.stage?.renderer?.info?.render?.frame ?? 0);
    console.log(`  ✓ ${shot.name} -> ${file}  (frames=${fps})`);
  } catch (e) {
    console.error(`  ✗ ${shot.name}: ${String(e).slice(0, 200)}`);
  }
}

await browser.close();
