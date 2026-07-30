/**
 * 把 three.js 自带的 Draco / KTX2 解码器从 node_modules 拷到 public/decoders/。
 *
 * 为什么不直接用 CDN：解码器版本必须和 three 版本对得上，CDN 上挂个 latest
 * 迟早会在某次 three 升级后悄悄崩掉；而且多一个外部依赖就多一个线上故障点。
 * 拷到 public 里自托管，版本跟着 package.json 走。
 *
 * 只有车模用了 Draco/KTX2 压缩时才需要跑这个。
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pairs = [
  ['node_modules/three/examples/jsm/libs/draco/', 'public/decoders/draco/'],
  ['node_modules/three/examples/jsm/libs/basis/', 'public/decoders/basis/'],
];

let ok = 0;
for (const [from, to] of pairs) {
  const src = resolve(root, from);
  const dst = resolve(root, to);
  if (!existsSync(src)) {
    console.error(`  ✗ 找不到 ${from}（three 版本变了？）`);
    continue;
  }
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
  console.log(`  ✓ ${from} → ${to}`);
  ok++;
}
process.exit(ok === pairs.length ? 0 : 1);
