import type { Race } from '../game/Race';
import type { Racer } from '../game/Racer';
import { formatTime } from '../core/MathUtil';
import { KART, SPEED_DISPLAY_SCALE } from '../core/Config';
import { Minimap } from './Minimap';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const DIAL_LEN = 268;
const RANK_SUFFIX = ['', 'st', 'nd', 'rd'];

/** 游戏内 HUD 的全部 DOM 更新 */
export class Hud {
  private root = $('hud');
  private elLap = $('hud-lap');
  private elRank = $('hud-rank');
  private elTime = $('hud-time');
  private elLapTime = $('hud-lap-time');
  private elBest = $('hud-best-time');
  private elSpeed = $('hud-speed');
  private dial = $<HTMLElement>('dial-fill');
  private speedo = document.querySelector('.speedo') as HTMLElement;
  private nitroCells = Array.from(
    $('nitro-cells').querySelectorAll<HTMLElement>('.ncell'),
  ).map((cell) => ({ cell, fill: cell.querySelector('i') as HTMLElement }));
  private driftFill = $('drift-fill');
  private toast = $('center-toast');
  private combo = $('combo-toast');
  private countdown = $('countdown');
  private standings = $('standings');
  private minimap: Minimap;

  private toastTimer = 0;
  private comboTimer = 0;
  private standingsHtml = '';

  constructor() {
    this.minimap = new Minimap($<HTMLCanvasElement>('minimap'));
  }

  show(): void { this.root.classList.remove('hidden'); }
  hide(): void {
    this.root.classList.add('hidden');
    this.countdown.classList.add('hidden');
  }

  setTrack(race: Race): void {
    this.minimap.setTrack(race.track);
    this.elBest.textContent = '--:--.--';
  }

  showCountdown(n: number): void {
    this.countdown.classList.remove('hidden');
    const text = n === 0 ? 'GO!' : String(n);
    const color = n === 0 ? '#35f5a0' : n === 1 ? '#ffd23f' : '#ff2fb9';
    this.countdown.innerHTML = `<span style="color:${color}">${text}</span>`;
    if (n === 0) setTimeout(() => this.countdown.classList.add('hidden'), 900);
  }

  toastMsg(text: string, color = '#22e6ff'): void {
    this.toast.textContent = text;
    this.toast.style.color = color;
    this.toast.classList.remove('show');
    void this.toast.offsetWidth; // 重启动画
    this.toast.classList.add('show');
    this.toastTimer = 1.5;
  }

  comboMsg(text: string): void {
    this.combo.textContent = text;
    this.combo.classList.remove('show');
    void this.combo.offsetWidth;
    this.combo.classList.add('show');
    this.comboTimer = 0.85;
  }

  /** 每渲染帧调用 */
  update(race: Race, dt: number): void {
    const p = race.player;
    const k = p.kart;

    // ---- 速度表 ----
    const kmh = Math.round(k.speed * SPEED_DISPLAY_SCALE);
    this.elSpeed.textContent = String(kmh);
    const ratio = Math.min(k.speed / (KART.maxSpeed + KART.nitroExtraSpeed), 1);
    this.dial.style.strokeDashoffset = String(DIAL_LEN * (1 - ratio));
    this.speedo.classList.toggle('boost', k.boostTime > 0);

    // ---- 氮气：逐格填充，满一格就能放 ----
    for (let i = 0; i < this.nitroCells.length; i++) {
      const amount = Math.max(0, Math.min(k.nitro - i, 1));
      const { cell, fill } = this.nitroCells[i];
      fill.style.width = `${amount * 100}%`;
      cell.classList.toggle('full', amount >= 1);
    }

    // ---- 集气 ----
    const dc = k.drifting ? k.driftCharge : 0;
    this.driftFill.style.width = `${dc * 100}%`;
    const tier = k.driftTier;
    this.driftFill.className = `fill${tier > 0 ? ` t${tier}` : ''}`;

    // ---- 圈数 / 排名 / 计时 ----
    const lap = Math.min(Math.max(p.lap, 1), race.config.laps);
    this.elLap.textContent = `${lap}/${race.config.laps}`;
    this.elRank.innerHTML = `${p.rank}<sup>${RANK_SUFFIX[p.rank] ?? 'th'}</sup>`;
    this.elTime.textContent = formatTime(race.time);
    this.elLapTime.textContent = formatTime(race.time - p.currentLapStart);
    if (isFinite(p.bestLap)) this.elBest.textContent = formatTime(p.bestLap);

    // ---- 逆行警告（低速脱困时不刷屏）----
    if (k.wrongWay && k.speed > 12 && this.toastTimer <= 0) this.toastMsg('逆行！掉头', '#ff4d5e');
    if (this.toastTimer > 0) this.toastTimer -= dt;
    if (this.comboTimer > 0) this.comboTimer -= dt;

    // ---- 名次条 ----
    this.updateStandings(race);

    // ---- 小地图 ----
    this.minimap.draw(race);
  }

  private updateStandings(race: Race): void {
    const sorted = race.standings();
    let html = '';
    for (const r of sorted) {
      const c = '#' + r.color.toString(16).padStart(6, '0');
      html += `<div class="row${r.isPlayer ? ' me' : ''}">`
        + `<span class="p">${r.rank}</span>`
        + `<span class="dot" style="background:${c}"></span>`
        + `<span class="nm">${escapeHtml(r.name)}</span>`
        + `</div>`;
    }
    if (html !== this.standingsHtml) {
      this.standings.innerHTML = html;
      this.standingsHtml = html;
    }
  }

  reset(): void {
    this.standingsHtml = '';
    this.standings.innerHTML = '';
    // 清空文字而不只是移除动画类，否则上一局的提示会以 opacity:0 残留在无障碍树里
    this.toast.classList.remove('show');
    this.toast.textContent = '';
    this.combo.classList.remove('show');
    this.combo.textContent = '';
    this.countdown.classList.add('hidden');
    this.countdown.innerHTML = '';
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** 结算表格 */
export function renderResults(standings: Racer[], laps: number): string {
  let html = '';
  for (const r of standings) {
    const posClass = r.rank <= 3 ? ` p${r.rank}` : '';
    // 玩家冲线就结束比赛，所以没跑完的对手不是"退赛"，只是被提前叫停了。
    // 标 DNF 会让人以为它们撞毁了。多圈赛显示跑到第几圈还有信息量；
    // 单圈赛写"第 1/1 圈"反而像是跑完了，直接写未完赛。
    const time = r.finished
      ? formatTime(r.finishTime)
      : laps > 1 ? `第 ${Math.min(r.lap, laps)}/${laps} 圈` : '未完赛';
    const best = isFinite(r.bestLap) ? formatTime(r.bestLap) : '--:--.--';
    html += `<tr class="${r.isPlayer ? 'me' : ''}">`
      + `<td class="pos${posClass}">${r.rank}</td>`
      + `<td>${escapeHtml(r.name)}</td>`
      + `<td class="tm">${time}</td>`
      + `<td class="tm">最快 ${best}</td>`
      + `</tr>`;
  }
  return html;
}
