/**
 * 下载 Khronos 官方示例资产里的 Car Concept 车模到 public/models/car.glb。
 *
 * 模型文件本身不入库（11MB 的二进制不适合放进 git，而且第三方资产另有授权），
 * 所以用脚本拉。授权与署名见仓库根目录 CREDITS.md —— CC BY 4.0，署名是强制的。
 *
 * 为什么选它：原创概念车（源头是一个 CC0 模型），不是真实车型复刻，
 * 不涉及车厂商标；自带 clearcoat 车漆、法线贴图和烘焙 AO；
 * 材质名和节点名规范（Paint 1 / WheelFrontL …），正好命中 CarModelLoader 的约定。
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const URL_ =
  'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/CarConcept/glTF-Binary/CarConcept.glb';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dst = resolve(root, 'public/models/car.glb');

const res = await fetch(URL_);
if (!res.ok) {
  console.error(`  ✗ 下载失败: HTTP ${res.status}`);
  process.exit(1);
}
mkdirSync(dirname(dst), { recursive: true });
await pipeline(Readable.fromWeb(res.body), createWriteStream(dst));
console.log(`  ✓ Car Concept → public/models/car.glb`);
console.log('    CC BY 4.0 · © 2024 Darmstadt Graphics Group GmbH · Eric Chadwick');
console.log('    署名已登记在 CREDITS.md，请勿删除');
