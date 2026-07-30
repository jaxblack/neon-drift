/** 检查 glb 的节点/材质命名，确认能不能命中 CarModelLoader 的约定。 */
import { readFileSync } from 'node:fs';

const buf = readFileSync(process.argv[2] ?? 'public/models/car.glb');
// GLB: magic(4) version(4) length(4) | chunkLen(4) chunkType(4) JSON...
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));

const nodes = json.nodes ?? [];
const wheelRe = /wheel|tire|tyre|rim/i;
const posRe = [
  ['FL', /fl|front.*left|left.*front/i],
  ['FR', /fr|front.*right|right.*front/i],
  ['RL', /rl|rear.*left|left.*rear|bl|back.*left/i],
  ['RR', /rr|rear.*right|right.*rear|br|back.*right/i],
];

console.log('== 节点总数:', nodes.length);
console.log('\n== 名字里带 wheel/tire/rim 的节点 ==');
const hits = nodes.map((n, i) => ({ i, name: n.name ?? '' })).filter((n) => wheelRe.test(n.name));
for (const h of hits) {
  const matched = posRe.filter(([, re]) => re.test(h.name)).map(([k]) => k);
  console.log(`  [${h.i}] ${h.name}   -> ${matched.length ? matched.join(',') : '(无法定位方位)'}`);
}
if (!hits.length) console.log('  (无)');

console.log('\n== 材质 ==');
(json.materials ?? []).forEach((m, i) => {
  const paint = /body|paint|carpaint|car_paint|shell/i.test(m.name ?? '');
  console.log(`  [${i}]${paint ? ' *车漆*' : '       '} ${m.name}`);
});

console.log('\n== 顶层节点 ==');
for (const s of json.scenes ?? []) {
  for (const i of s.nodes ?? []) console.log(`  [${i}] ${nodes[i]?.name}`);
}

const prim = (json.meshes ?? []).reduce((a, m) => a + (m.primitives?.length ?? 0), 0);
console.log(`\n== mesh ${json.meshes?.length ?? 0} / primitive ${prim} / 贴图 ${json.images?.length ?? 0}`);
console.log('== extensionsUsed:', (json.extensionsUsed ?? []).join(', '));
