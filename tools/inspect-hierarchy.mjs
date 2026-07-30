/** 打印车轮节点的父子关系，确认该旋转哪个节点。 */
import { readFileSync } from 'node:fs';

const b = readFileSync(process.argv[2] ?? 'public/models/car.glb');
const j = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
const n = j.nodes;
const parent = {};
n.forEach((x, i) => (x.children ?? []).forEach((c) => { parent[c] = i; }));

for (let i = 0; i < n.length; i++) {
  if (!/wheel/i.test(n[i].name ?? '')) continue;
  if (/steering/i.test(n[i].name)) continue;
  const p = parent[i];
  const kids = (n[i].children ?? []).map((c) => n[c].name).join(', ') || '—';
  console.log(`[${i}] ${n[i].name}`);
  console.log(`     parent  : ${p === undefined ? '(root)' : `[${p}] ${n[p].name}`}`);
  console.log(`     children: ${kids}`);
}
