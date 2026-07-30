import './styles.css';

import { GameLoop } from './core/GameLoop';
import { Input, emptyInput, type InputState } from './core/Input';
import { AudioEngine } from './core/Audio';
import { Stage, type Quality } from './render/Stage';
import { Race, type RaceConfig } from './game/Race';
import { TRACKS } from './track/Track';
import { Hud, renderResults, escapeHtml } from './ui/Hud';
import { TouchControls, isTouchDevice, requestGyroPermission, type SteerMode } from './ui/TouchControls';
import { KART, type Difficulty } from './core/Config';

// ============================================================
// 设置
// ============================================================
interface Settings {
  trackId: string;
  laps: number;
  aiCount: number;
  difficulty: Difficulty;
  playerName: string;
  quality: Quality;
  audio: boolean;
  /** 移动端转向方式 */
  steerMode: SteerMode;
  /** 移动端自动油门 */
  autoThrottle: boolean;
  /** 陀螺仪满舵倾角（度），越小越灵敏 */
  gyroRange: number;
}

const SAVE_KEY = 'neon-drift/settings/v2';

function loadSettings(): Settings {
  const def: Settings = {
    trackId: TRACKS[0].id, laps: 3, aiCount: 5,
    difficulty: 'normal', playerName: '你',
    quality: guessQuality(), audio: true,
    steerMode: 'wheel', autoThrottle: false, gyroRange: 26,
  };
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return def;
    const s = JSON.parse(raw) as Partial<Settings>;
    return {
      ...def,
      ...s,
      // 校验，防止旧存档里的非法值
      trackId: TRACKS.some((t) => t.id === s.trackId) ? s.trackId! : def.trackId,
      laps: [1, 3, 5].includes(s.laps as number) ? s.laps! : def.laps,
      aiCount: typeof s.aiCount === 'number' && s.aiCount >= 0 && s.aiCount <= 7 ? s.aiCount : def.aiCount,
      steerMode: s.steerMode === 'gyro' ? 'gyro' : def.steerMode,
      gyroRange: [18, 26, 34].includes(s.gyroRange as number) ? s.gyroRange! : def.gyroRange,
    };
  } catch {
    return def;
  }
}

function saveSettings(s: Settings): void {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch { /* 隐私模式忽略 */ }
}

function guessQuality(): Quality {
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  if (mem <= 4 || cores <= 4) return 'medium';
  return 'high';
}

const settings = loadSettings();

// ============================================================
// DOM
// ============================================================
const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('game-canvas');
const app = $('app');
const menu = $('menu');
const help = $('help');
const pause = $('pause');
const result = $('result');
const loading = $('loading');

// ============================================================
// 核心系统
// ============================================================
const stage = new Stage(canvas, settings.quality);
const audio = new AudioEngine();
const input = new Input(canvas);
const hud = new Hud();

// ---------- 移动端 ----------
const touchDevice = isTouchDevice();
let touch: TouchControls | null = null;

if (touchDevice) {
  document.body.classList.add('touch-mode');
  document.querySelectorAll('.touch-only').forEach((el) => el.classList.remove('hidden'));
  touch = new TouchControls(input, {
    steerMode: settings.steerMode,
    autoThrottle: settings.autoThrottle,
    gyroRange: settings.gyroRange,
  });
  touch.onPause = () => { if (race && result.classList.contains('hidden')) togglePause(); };
  touch.onCamera = () => input.onCamera?.();
  touch.onCalibrate = () => hud.toastMsg('方向已校准', '#35f5a0');
  touch.onGyroUnavailable = () => {
    hud.toastMsg('未检测到陀螺仪，已切回摇杆', '#ff4d5e');
    settings.steerMode = 'wheel';
    saveSettings(settings);
    syncTouchSettings();
    markActive('steer-picker', 'steer', 'wheel');
  };
}

function syncTouchSettings(): void {
  touch?.applySettings({
    steerMode: settings.steerMode,
    autoThrottle: settings.autoThrottle,
    gyroRange: settings.gyroRange,
  });
}

/** 让某个 picker 里 data-<attr>=value 的 chip 高亮 */
function markActive(boxId: string, attr: string, value: string): void {
  const box = document.getElementById(boxId);
  if (!box) return;
  box.querySelectorAll<HTMLButtonElement>('.chip').forEach((c) => {
    c.classList.toggle('active', c.dataset[attr] === value);
  });
}

let race: Race | null = null;
let paused = false;
let shakeCooldown = 0;

audio.setEnabled(settings.audio);

input.onPause = () => {
  if (!race) return;
  if (result.classList.contains('hidden')) togglePause();
};
input.onCamera = () => {
  if (!race || paused) return;
  const m = stage.cycleCameraMode();
  hud.toastMsg(m === 'chase' ? '跟随视角' : m === 'far' ? '远景视角' : '车头视角', '#8b5cff');
  audio.ui();
};

// ============================================================
// 主循环
// ============================================================
const loop = new GameLoop(
  (dt, first) => {
    if (!race || paused) return;
    race.step(dt, pendingInput, first);
  },
  (alpha, frameDt) => {
    if (race && !paused) {
      race.render(alpha, frameDt);
      hud.update(race, frameDt);
      const k = race.player.kart;
      audio.updateEngine(
        k.speed / KART.maxSpeed,
        pendingInput.throttle,
        k.slip,
        k.boostTime > 0,
        k.offroad,
        frameDt,
        k.drifting,
        k.driftCharge,
      );
      if (shakeCooldown > 0) shakeCooldown -= frameDt;
    }
    stage.render();
  },
);

/** 每渲染帧采样一次输入，物理的多个 substep 复用 */
let pendingInput: InputState = emptyInput();

function sampleLoopInput(dt: number): void {
  if (race && !paused) {
    touch?.update();
    pendingInput = input.sample(dt);
  } else {
    pendingInput = emptyInput();
  }
}

// 用 rAF 在 GameLoop 之前采样输入
(function inputPump(last = performance.now()): void {
  requestAnimationFrame((now) => {
    sampleLoopInput(Math.min((now - last) / 1000, 0.1));
    inputPump(now);
  });
})();

loop.start();

// ============================================================
// 比赛生命周期
// ============================================================
function startRace(): void {
  loading.classList.remove('hidden');
  menu.classList.add('hidden');
  result.classList.add('hidden');
  pause.classList.add('hidden');

  // 让浏览器先画出 loading，再做重活
  requestAnimationFrame(() => setTimeout(() => {
    disposeRace();
    const cfg: RaceConfig = {
      trackId: settings.trackId,
      laps: settings.laps,
      aiCount: settings.aiCount,
      difficulty: settings.difficulty,
      playerName: settings.playerName,
    };
    race = new Race(stage, audio, cfg);
    wireRaceCallbacks(race);
    hud.reset();
    hud.setTrack(race);
    hud.show();
    input.reset();
    touch?.show();
    paused = false;
    loading.classList.add('hidden');
    void audio.start();
  }, 30));
}

function wireRaceCallbacks(r: Race): void {
  r.cb = {
    onCountdown: (n) => hud.showCountdown(n),
    onStart: () => hud.showCountdown(0),
    onLap: (racer, lapTime, best) => {
      if (!racer.isPlayer) return;
      if (lapTime > 0) {
        hud.toastMsg(best ? '最快圈速！' : `第 ${racer.lap - 1} 圈完成`, best ? '#35f5a0' : '#22e6ff');
      }
    },
    onFinish: (racer) => {
      if (racer.isPlayer) {
        hud.toastMsg(`冲线！第 ${racer.rank} 名`, racer.rank === 1 ? '#ffd23f' : '#22e6ff');
      }
    },
    onRaceOver: (standings) => showResults(standings),
    onToast: (text, color) => hud.toastMsg(text, color),
    onCombo: (text) => hud.comboMsg(text),
    onShake: (amount) => {
      stage.addShake(amount);
      if (amount > 0.5 && shakeCooldown <= 0) {
        shakeCooldown = 0.5;
        app.classList.add('shake');
        setTimeout(() => app.classList.remove('shake'), 300);
      }
    },
  };
}

function showResults(standings: ReturnType<Race['standings']>): void {
  const me = standings.find((s) => s.isPlayer);
  const title = $('result-title');
  if (me) {
    const r = me.rank;
    title.textContent = r === 1 ? '🏆 冠军！' : r <= 3 ? `🥈 第 ${r} 名` : `第 ${r} 名`;
    title.style.color = r === 1 ? '#ffd23f' : r <= 3 ? '#e6f0ff' : '#7f8ba8';
  }
  $('result-rows').innerHTML = renderResults(standings, settings.laps);
  result.classList.remove('hidden');
  hud.hide();
  touch?.hide();
  audio.silence();
}

function disposeRace(): void {
  if (!race) return;
  race.dispose();
  race = null;
}

function quitToMenu(): void {
  disposeRace();
  hud.hide();
  touch?.hide();
  hud.reset();
  audio.silence();
  paused = false;
  pause.classList.add('hidden');
  result.classList.add('hidden');
  menu.classList.remove('hidden');
}

function togglePause(): void {
  if (!race) return;
  paused = !paused;
  pause.classList.toggle('hidden', !paused);
  if (paused) { audio.silence(); input.reset(); touch?.reset(); }
  audio.ui();
}

// ============================================================
// 菜单
// ============================================================
function buildTrackPicker(): void {
  const box = $('track-picker');
  box.innerHTML = '';
  for (const t of TRACKS) {
    const b = document.createElement('button');
    b.className = 'chip' + (t.id === settings.trackId ? ' active' : '');
    b.dataset.track = t.id;
    b.innerHTML = `${escapeHtml(t.name)}<small>${escapeHtml(t.desc)}</small>`;
    b.onclick = () => {
      settings.trackId = t.id;
      saveSettings(settings);
      box.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      b.classList.add('active');
      audio.ui();
    };
    box.appendChild(b);
  }
}

function bindPicker(id: string, key: keyof Settings, attr: string, parse: (v: string) => unknown, after?: () => void): void {
  const box = document.getElementById(id);
  if (!box) return;
  box.querySelectorAll<HTMLButtonElement>('.chip').forEach((b) => {
    const val = b.dataset[attr];
    if (val !== undefined && parse(val) === settings[key]) {
      box.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      b.classList.add('active');
    }
    b.onclick = () => {
      if (val === undefined) return;
      (settings[key] as unknown) = parse(val);
      saveSettings(settings);
      box.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      b.classList.add('active');
      after?.();
      audio.ui();
    };
  });
}

buildTrackPicker();
bindPicker('laps-picker', 'laps', 'laps', (v) => Number(v));
bindPicker('ai-picker', 'aiCount', 'ai', (v) => Number(v));
bindPicker('diff-picker', 'difficulty', 'diff', (v) => v);

if (touchDevice) {
  $('touch-settings').classList.remove('hidden');
  markActive('steer-picker', 'steer', settings.steerMode);
  markActive('throttle-picker', 'auto', settings.autoThrottle ? '1' : '0');
  markActive('gyro-range-picker', 'range', String(settings.gyroRange));

  document.querySelectorAll<HTMLButtonElement>('#steer-picker .chip').forEach((b) => {
    b.onclick = async () => {
      const mode = (b.dataset.steer === 'gyro' ? 'gyro' : 'wheel') as SteerMode;
      // iOS 需要在用户手势里申请传感器权限
      if (mode === 'gyro' && !(await requestGyroPermission())) {
        hud.toastMsg('陀螺仪权限被拒绝', '#ff4d5e');
        return;
      }
      settings.steerMode = mode;
      saveSettings(settings);
      markActive('steer-picker', 'steer', mode);
      syncTouchSettings();
      audio.ui();
    };
  });
  bindPicker('throttle-picker', 'autoThrottle', 'auto', (v) => v === '1', syncTouchSettings);
  bindPicker('gyro-range-picker', 'gyroRange', 'range', (v) => Number(v), syncTouchSettings);
}

$('btn-start').onclick = () => { void audio.start(); void goImmersive(); startRace(); };
$('btn-help').onclick = () => { help.classList.remove('hidden'); audio.ui(); };
$('btn-help-close').onclick = () => { help.classList.add('hidden'); audio.ui(); };
$('btn-resume').onclick = () => togglePause();
$('btn-restart').onclick = () => startRace();
$('btn-quit').onclick = () => quitToMenu();
$('btn-again').onclick = () => startRace();
$('btn-menu').onclick = () => quitToMenu();

// ============================================================
// 移动端沉浸模式 / 竖屏提示
// ============================================================
/** 手机上开赛时尽量进入全屏并锁定横屏（不支持就静默忽略） */
async function goImmersive(): Promise<void> {
  if (!touchDevice) return;
  try {
    if (!document.fullscreenElement) await app.requestFullscreen?.();
  } catch { /* 用户或浏览器拒绝，忽略 */ }
  try {
    const o = screen.orientation as ScreenOrientation & { lock?: (v: string) => Promise<void> };
    await o?.lock?.('landscape');
  } catch { /* 桌面/iOS 不支持，忽略 */ }
}

const rotateHint = $('rotate-hint');
function updateRotateHint(): void {
  const portrait = window.innerHeight > window.innerWidth;
  rotateHint.classList.toggle('hidden', !(touchDevice && portrait));
}
updateRotateHint();

// ============================================================
// 窗口事件
// ============================================================
window.addEventListener('resize', () => { stage.resize(); updateRotateHint(); });
window.addEventListener('orientationchange', () => updateRotateHint());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    audio.suspend();
    if (race && !paused && result.classList.contains('hidden')) togglePause();
  } else {
    audio.resume();
  }
});

// 开发期在控制台暴露句柄，方便调手感
Object.assign(window as unknown as Record<string, unknown>, {
  __neon: { get race() { return race; }, stage, settings, audio },
});
