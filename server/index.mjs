#!/usr/bin/env node
/**
 * NEON DRIFT 服务端（Phase N1：relay 模式 + 静态托管）
 *
 * 本地：  npm run server         → http://localhost:8090
 * 腾讯云：npm run build && node server/index.mjs
 *         （建议前面挂 Nginx 做 TLS 终止，把 /ws 反代到这里）
 *
 * 环境变量：
 *   PORT             监听端口，默认 8090
 *   MAX_ROOM_SIZE    单房间人数上限，默认 8
 *   ALLOWED_ORIGINS  逗号分隔的允许来源；留空表示只允许同源 + localhost
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const PORT = Number(process.env.PORT ?? 8090);
const MAX_ROOM_SIZE = Number(process.env.MAX_ROOM_SIZE ?? 8);
const MAX_MSG_BYTES = 4 * 1024;
const TICK_HZ = 20;
const SNAP_STRIDE = 11;
const PROTOCOL_VERSION = 1;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

// ============================================================
// 静态文件服务（带路径穿越防护）
// ============================================================
const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method Not Allowed');
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      players: [...rooms.values()].reduce((n, r) => n + r.clients.size, 0),
      uptime: Math.round(process.uptime()),
    }));
    return;
  }

  if (url.pathname === '/api/rooms') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([...rooms.entries()].map(([name, r]) => ({
      name, players: r.clients.size, trackId: r.trackId, laps: r.laps,
    }))));
    return;
  }

  // dist/ 静态资源
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const abs = path.join(DIST, rel);
  // 防路径穿越：解析后必须仍在 DIST 内
  if (!abs.startsWith(DIST + path.sep) && abs !== DIST) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      // SPA 回退
      const idx = path.join(DIST, 'index.html');
      fs.readFile(idx, (e2, buf) => {
        if (e2) { res.writeHead(404).end('Not found — 先执行 npm run build'); return; }
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(buf);
      });
      return;
    }
    const type = MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
    const immutable = rel.startsWith('/assets/');
    res.writeHead(200, {
      'content-type': type,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(abs).pipe(res);
  });
});

// ============================================================
// WebSocket 房间
// ============================================================
/** @type {Map<string, {clients: Map<number, any>, trackId: string, laps: number, tick: number}>} */
const rooms = new Map();
let nextId = 1;

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: MAX_MSG_BYTES,
  verifyClient: ({ origin, req }) => {
    if (!origin) return true; // 非浏览器客户端
    if (ALLOWED_ORIGINS.length) return ALLOWED_ORIGINS.includes(origin);
    try {
      const host = req.headers.host ?? '';
      const o = new URL(origin);
      return o.host === host || o.hostname === 'localhost' || o.hostname === '127.0.0.1';
    } catch {
      return false;
    }
  },
});

const sanitizeName = (s) =>
  String(s ?? '').replace(/[<>&"'\\]/g, '').trim().slice(0, 14) || '车手';

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.joined = false;
  ws.id = nextId++;
  ws.msgCount = 0;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    // 简易限流：单连接每秒最多 120 条
    ws.msgCount++;
    if (ws.msgCount > 120) return;

    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    switch (m.t) {
      case 'join': return onJoin(ws, m);
      case 'state': return onState(ws, m);
      case 'event': return onEvent(ws, m);
      case 'ping':
        return sendJson(ws, { t: 'pong', ts: Number(m.ts) || 0, now: Date.now() });
      default: return;
    }
  });

  ws.on('close', () => {
    if (!ws.joined) return;
    const room = rooms.get(ws.room);
    if (!room) return;
    room.clients.delete(ws.id);
    broadcast(room, { t: 'peer_leave', id: ws.id }, ws.id);
    if (room.clients.size === 0) rooms.delete(ws.room);
    else console.log(`[room ${ws.room}] ${ws.name} 离开，剩余 ${room.clients.size}`);
  });
});

function onJoin(ws, m) {
  if (ws.joined) return;
  if (Number(m.v) !== PROTOCOL_VERSION) {
    sendJson(ws, { t: 'error', msg: '协议版本不匹配，请刷新页面' });
    return ws.close();
  }
  const roomName = String(m.room ?? 'lobby').replace(/[^\w\u4e00-\u9fa5-]/g, '').slice(0, 24) || 'lobby';
  let room = rooms.get(roomName);
  if (!room) {
    room = { clients: new Map(), trackId: 'neon-city', laps: 3, tick: 0 };
    rooms.set(roomName, room);
  }
  if (room.clients.size >= MAX_ROOM_SIZE) {
    sendJson(ws, { t: 'error', msg: '房间已满' });
    return ws.close();
  }

  ws.joined = true;
  ws.room = roomName;
  ws.name = sanitizeName(m.name);
  ws.color = Number.isFinite(m.color) ? (m.color >>> 0) & 0xffffff : 0x22e6ff;
  ws.pose = null;

  const peers = [...room.clients.values()].map((c) => ({ id: c.id, name: c.name, color: c.color }));
  room.clients.set(ws.id, ws);

  sendJson(ws, {
    t: 'welcome', v: PROTOCOL_VERSION, id: ws.id, room: roomName,
    trackId: room.trackId, laps: room.laps, peers, now: Date.now(),
  });
  broadcast(room, { t: 'peer_join', peer: { id: ws.id, name: ws.name, color: ws.color } }, ws.id);
  console.log(`[room ${roomName}] ${ws.name} 加入，共 ${room.clients.size} 人`);
}

const num = (v) => (Number.isFinite(v) ? v : 0);

function onState(ws, m) {
  if (!ws.joined) return;
  ws.pose = [
    ws.id,
    num(m.x), num(m.y), num(m.z), num(m.h),
    num(m.vx), num(m.vz),
    (num(m.f) | 0) & 0xff,
    Math.max(0, Math.min(255, num(m.c) | 0)),
    Math.max(0, num(m.lap) | 0),
    num(m.dist) | 0,
  ];
}

function onEvent(ws, m) {
  if (!ws.joined) return;
  const room = rooms.get(ws.room);
  if (!room) return;
  const kind = String(m.kind ?? '').slice(0, 16);
  broadcast(room, { t: 'event', from: ws.id, kind, data: m.data }, ws.id);
}

function sendJson(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, exceptId) {
  const s = JSON.stringify(obj);
  for (const c of room.clients.values()) {
    if (c.id === exceptId) continue;
    if (c.readyState === c.OPEN) c.send(s);
  }
}

// 固定频率广播快照
setInterval(() => {
  for (const room of rooms.values()) {
    room.tick++;
    const flat = [];
    for (const c of room.clients.values()) {
      if (c.pose) {
        for (let i = 0; i < SNAP_STRIDE; i++) flat.push(c.pose[i]);
      }
    }
    if (flat.length) broadcast(room, { t: 'snap', tick: room.tick, s: flat }, -1);
  }
}, 1000 / TICK_HZ);

// 心跳 + 限流窗口重置
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);
setInterval(() => { for (const ws of wss.clients) ws.msgCount = 0; }, 1000);

server.listen(PORT, () => {
  console.log(`\n  NEON DRIFT server`);
  console.log(`  HTTP  http://localhost:${PORT}`);
  console.log(`  WS    ws://localhost:${PORT}/ws`);
  console.log(`  静态目录 ${DIST}${fs.existsSync(DIST) ? '' : '  (还没 build)'}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n正在关闭…');
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  });
}
