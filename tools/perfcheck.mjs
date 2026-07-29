/** 画面改动后的性能 / 错误回归。跑满一局，统计 FPS、显存对象、控制台错误。 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-frame-rate-limit'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 300)));

await page.goto('https://qlili.com/speed/', { waitUntil: 'load' });
await page.waitForSelector('#btn-start', { timeout: 20000 });
await page.evaluate(() => {
  document.querySelector('#track-picker .chip:nth-child(1)')?.click();
  document.querySelector('#ai-picker .chip:nth-child(4)')?.click(); // 7 名 AI，最重负载
  [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '1 圈')?.click();
  document.getElementById('btn-start').click();
});
await page.waitForFunction(() => window.__neon?.race, null, { timeout: 40000 });

const snap = () => page.evaluate(() => {
  const i = window.__neon.stage.renderer.info;
  return { geo: i.memory.geometries, tex: i.memory.textures, calls: i.render.calls, tris: i.render.triangles };
});

await page.evaluate(() => {
  window.__neon.race.autopilot = true;
  window.__F = { n: 0, t0: performance.now() };
  const tick = () => { window.__F.n++; requestAnimationFrame(tick); };
  tick();
});
const early = await snap();
await page.waitForTimeout(45000);
const late = await snap();

const out = await page.evaluate(() => {
  const F = window.__F;
  const r = window.__neon.race;
  return {
    fps: +(F.n / ((performance.now() - F.t0) / 1000)).toFixed(1),
    lap: r.player.lap,
    finished: !!document.querySelector('#results:not(.hidden), .results:not(.hidden)'),
  };
});

console.log(JSON.stringify({
  ...out,
  drawCalls: late.calls,
  triangles: late.tris,
  geometries: `${early.geo} -> ${late.geo}`,
  textures: `${early.tex} -> ${late.tex}`,
  leak: late.geo > early.geo + 8 || late.tex > early.tex + 4 ? 'SUSPECT' : 'none',
  consoleErrors: errors.length ? errors.slice(0, 5) : 'none',
}, null, 2));

await browser.close();
