/**
 * 客户端 ↔ 服务端消息协议。
 * 这份文件被前端和 server/index.mjs 共同参考（服务端是 .mjs，靠约定同步）。
 *
 * 当前阶段（Phase N1）：relay 模式 —— 每个客户端本地模拟自己的车，
 * 按固定频率广播位姿；其他玩家的车在本地做插值。
 * 后续（Phase N2）可升级为服务器权威 + 客户端预测：
 * 客户端发 InputFrame，服务端跑同一份 Kart 物理并回 Snapshot，
 * 客户端用 lastAckTick 重放本地输入做 reconciliation。
 */

export const PROTOCOL_VERSION = 1;

/** 状态广播频率（Hz） */
export const NET_SEND_HZ = 20;

// ---------------- 客户端 → 服务端 ----------------

export interface C2SJoin {
  t: 'join';
  v: number;
  room: string;
  name: string;
  color: number;
}

/** relay 模式下的位姿广播 */
export interface C2SState {
  t: 'state';
  /** 客户端本地物理 tick */
  tick: number;
  x: number; y: number; z: number;
  h: number;   // heading
  vx: number; vz: number;
  /** 打包的状态位：drifting | boosting | offroad */
  f: number;
  /** 集气 0..255 */
  c: number;
  lap: number;
  dist: number;
}

/** 服务器权威模式用（暂未启用） */
export interface C2SInput {
  t: 'input';
  tick: number;
  /** throttle/brake/steer/drift/nitro/item 压缩后的整数 */
  k: number;
  steer: number;
}

export interface C2SEvent {
  t: 'event';
  kind: 'item_use' | 'boost' | 'hit' | 'finish';
  data?: Record<string, number | string>;
}

export interface C2SPing { t: 'ping'; ts: number; }

export type C2S = C2SJoin | C2SState | C2SInput | C2SEvent | C2SPing;

// ---------------- 服务端 → 客户端 ----------------

export interface S2CWelcome {
  t: 'welcome';
  v: number;
  id: number;
  room: string;
  trackId: string;
  laps: number;
  /** 房间内已有玩家 */
  peers: PeerInfo[];
  /** 服务器时间（ms），用于时钟同步 */
  now: number;
}

export interface PeerInfo {
  id: number;
  name: string;
  color: number;
}

export interface S2CPeerJoin { t: 'peer_join'; peer: PeerInfo; }
export interface S2CPeerLeave { t: 'peer_leave'; id: number; }

export interface S2CSnapshot {
  t: 'snap';
  /** 服务器 tick */
  tick: number;
  /** [id, x, y, z, h, vx, vz, flags, charge, lap, dist] 扁平数组，省带宽 */
  s: number[];
}

export interface S2CEvent {
  t: 'event';
  from: number;
  kind: string;
  data?: Record<string, number | string>;
}

export interface S2CStart { t: 'start'; at: number; }
export interface S2CPong { t: 'pong'; ts: number; now: number; }
export interface S2CError { t: 'error'; msg: string; }

export type S2C = S2CWelcome | S2CPeerJoin | S2CPeerLeave | S2CSnapshot
  | S2CEvent | S2CStart | S2CPong | S2CError;

// ---------------- 状态位打包 ----------------

export const FLAG_DRIFT = 1 << 0;
export const FLAG_BOOST = 1 << 1;
export const FLAG_OFFROAD = 1 << 2;
export const FLAG_AIR = 1 << 3;
export const FLAG_SPIN = 1 << 4;
export const FLAG_FINISHED = 1 << 5;

/** 每辆车在 snapshot 里占的字段数 */
export const SNAP_STRIDE = 11;
