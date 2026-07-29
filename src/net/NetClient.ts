import {
  PROTOCOL_VERSION, NET_SEND_HZ, SNAP_STRIDE,
  FLAG_DRIFT, FLAG_BOOST, FLAG_OFFROAD, FLAG_AIR, FLAG_SPIN, FLAG_FINISHED,
  type C2S, type S2C, type PeerInfo,
} from './protocol';
import type { Kart } from '../physics/Kart';

/** 远端玩家的一份可插值状态 */
export interface RemoteState {
  id: number;
  info: PeerInfo;
  /** 上一份与最新一份，渲染时在两者之间插值 */
  prev: PoseSample;
  next: PoseSample;
  /** 收到 next 的本地时间戳（ms） */
  nextAt: number;
  lap: number;
  dist: number;
  flags: number;
  charge: number;
}

export interface PoseSample {
  x: number; y: number; z: number; h: number; vx: number; vz: number;
}

export type NetStatus = 'offline' | 'connecting' | 'online' | 'error';

export interface NetEvents {
  onStatus?: (s: NetStatus, detail?: string) => void;
  onWelcome?: (id: number, trackId: string, laps: number, peers: PeerInfo[]) => void;
  onPeerJoin?: (p: PeerInfo) => void;
  onPeerLeave?: (id: number) => void;
  onRemoteEvent?: (from: number, kind: string, data?: Record<string, number | string>) => void;
  onStart?: (atServerTime: number) => void;
}

/**
 * 联机客户端（骨架，默认不启用）。
 *
 * 目前实现 relay 模式，够跑通"看到别人的车"。
 * 升级到服务器权威时只需要：
 *   1. sendState → sendInput
 *   2. applySnapshot 里对本地车做 reconciliation（重放未确认输入）
 * 其余（插值、房间、事件广播）不用改。
 */
export class NetClient {
  private ws: WebSocket | null = null;
  private sendTimer = 0;
  private selfId = -1;
  private serverTimeOffset = 0;
  private rtt = 0;
  readonly remotes = new Map<number, RemoteState>();
  status: NetStatus = 'offline';
  events: NetEvents = {};

  get id(): number { return this.selfId; }
  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }
  get latency(): number { return this.rtt; }
  get serverNow(): number { return Date.now() + this.serverTimeOffset; }

  connect(url: string, room: string, name: string, color: number): void {
    this.disconnect();
    this.setStatus('connecting');
    try {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        this.send({ t: 'join', v: PROTOCOL_VERSION, room, name, color });
        this.setStatus('online');
        this.pingLoop();
      };
      ws.onmessage = (e) => this.handle(e.data as string);
      ws.onclose = () => { this.setStatus('offline'); this.cleanup(); };
      ws.onerror = () => this.setStatus('error', '连接失败');
    } catch (err) {
      this.setStatus('error', String(err));
    }
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.cleanup();
    this.setStatus('offline');
  }

  private cleanup(): void {
    this.remotes.clear();
    this.selfId = -1;
  }

  private setStatus(s: NetStatus, detail?: string): void {
    this.status = s;
    this.events.onStatus?.(s, detail);
  }

  private send(m: C2S): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private pingLoop(): void {
    if (!this.connected) return;
    this.send({ t: 'ping', ts: Date.now() });
    setTimeout(() => this.pingLoop(), 2000);
  }

  private handle(raw: string): void {
    let m: S2C;
    try { m = JSON.parse(raw) as S2C; } catch { return; }
    switch (m.t) {
      case 'welcome':
        this.selfId = m.id;
        this.serverTimeOffset = m.now - Date.now();
        for (const p of m.peers) this.ensureRemote(p);
        this.events.onWelcome?.(m.id, m.trackId, m.laps, m.peers);
        break;
      case 'peer_join':
        this.ensureRemote(m.peer);
        this.events.onPeerJoin?.(m.peer);
        break;
      case 'peer_leave':
        this.remotes.delete(m.id);
        this.events.onPeerLeave?.(m.id);
        break;
      case 'snap':
        this.applySnapshot(m.s);
        break;
      case 'event':
        this.events.onRemoteEvent?.(m.from, m.kind, m.data);
        break;
      case 'start':
        this.events.onStart?.(m.at);
        break;
      case 'pong':
        this.rtt = Date.now() - m.ts;
        this.serverTimeOffset = m.now + this.rtt / 2 - Date.now();
        break;
      case 'error':
        this.setStatus('error', m.msg);
        break;
    }
  }

  private ensureRemote(p: PeerInfo): RemoteState {
    let r = this.remotes.get(p.id);
    if (!r) {
      const zero: PoseSample = { x: 0, y: 0, z: 0, h: 0, vx: 0, vz: 0 };
      r = {
        id: p.id, info: p,
        prev: { ...zero }, next: { ...zero }, nextAt: performance.now(),
        lap: 0, dist: 0, flags: 0, charge: 0,
      };
      this.remotes.set(p.id, r);
    }
    return r;
  }

  private applySnapshot(s: number[]): void {
    const now = performance.now();
    for (let i = 0; i + SNAP_STRIDE <= s.length; i += SNAP_STRIDE) {
      const id = s[i];
      if (id === this.selfId) continue;
      const r = this.remotes.get(id);
      if (!r) continue;
      r.prev = { ...r.next };
      r.next = { x: s[i + 1], y: s[i + 2], z: s[i + 3], h: s[i + 4], vx: s[i + 5], vz: s[i + 6] };
      r.flags = s[i + 7];
      r.charge = s[i + 8] / 255;
      r.lap = s[i + 9];
      r.dist = s[i + 10];
      r.nextAt = now;
    }
  }

  /** 每渲染帧调用：把远端车的位置插值到当前时刻 */
  interpolate(r: RemoteState): PoseSample {
    const dt = (performance.now() - r.nextAt) / 1000;
    const span = 1 / NET_SEND_HZ;
    const t = Math.min(dt / span, 1.6); // 允许轻微外推，掩盖丢包
    return {
      x: r.prev.x + (r.next.x - r.prev.x) * t,
      y: r.prev.y + (r.next.y - r.prev.y) * t,
      z: r.prev.z + (r.next.z - r.prev.z) * t,
      h: r.prev.h + shortestAngle(r.prev.h, r.next.h) * t,
      vx: r.next.vx,
      vz: r.next.vz,
    };
  }

  /** 每渲染帧调用，内部按 NET_SEND_HZ 节流 */
  tick(dt: number, kart: Kart, lap: number, tickNo: number, finished: boolean): void {
    if (!this.connected) return;
    this.sendTimer -= dt;
    if (this.sendTimer > 0) return;
    this.sendTimer = 1 / NET_SEND_HZ;

    let f = 0;
    if (kart.drifting) f |= FLAG_DRIFT;
    if (kart.boostTime > 0) f |= FLAG_BOOST;
    if (kart.offroad) f |= FLAG_OFFROAD;
    if (!kart.grounded) f |= FLAG_AIR;
    if (kart.spinOut > 0) f |= FLAG_SPIN;
    if (finished) f |= FLAG_FINISHED;

    this.send({
      t: 'state',
      tick: tickNo,
      x: round2(kart.x), y: round2(kart.y), z: round2(kart.z),
      h: round3(kart.heading),
      vx: round2(kart.vx), vz: round2(kart.vz),
      f,
      c: Math.round(kart.driftCharge * 255),
      lap,
      dist: Math.round(kart.trackDist),
    });
  }

  emit(kind: 'item_use' | 'boost' | 'hit' | 'finish', data?: Record<string, number | string>): void {
    this.send({ t: 'event', kind, data });
  }
}

function round2(v: number): number { return Math.round(v * 100) / 100; }
function round3(v: number): number { return Math.round(v * 1000) / 1000; }

function shortestAngle(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
