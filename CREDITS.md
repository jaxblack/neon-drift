# 第三方资产署名

游戏本体（代码、程序化几何体、程序化贴图、程序化音效）是 MIT，见 [LICENSE](LICENSE)。

本文件登记引入的第三方美术资产。**CC-BY 类资产的署名是许可协议的强制要求，
不是可选项** —— 用了就必须在这里登记，删掉署名等于违约。

## 车模

| 资产 | 作者 | 来源 | 许可 |
| --- | --- | --- | --- |
| Car Concept（游戏内“概念车”） | © 2024 Darmstadt Graphics Group GmbH；模型与贴图作者 Eric Chadwick | [KhronosGroup/glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode) |
| `ferrari.glb`（游戏内“超跑”） | vicent091036 | [mrdoob/three.js](https://github.com/mrdoob/three.js/blob/dev/examples/models/gltf/ferrari.glb)（随 `webgl_materials_car` 示例分发） | [MIT](https://github.com/mrdoob/three.js/blob/dev/LICENSE)（three.js 仓库许可） |

### Car Concept 补充说明

- 该资产改编自 Unity Fan 发布的 **CC0（公共领域）** 概念车模型。
  它是**原创概念车，不是任何真实车型的复刻**，因此不涉及车厂的商标或外观设计权。
- 模型车尾牌照及方向盘上带有 **Khronos / 3D Commerce 徽标**。按上游 README，
  这些属于 "Khronos Trademark or Logo"（不受版权保护的徽标），随资产一同分发。
- 本项目未修改该资产的几何，仅在运行时做了归一化（等比缩放、贴地、朝向）、
  按阵营色替换车漆材质颜色、隐藏内饰网格以降低 draw call。

### `ferrari.glb` 补充说明

- 该文件直接取自 three.js 仓库的 `examples/models/gltf/`，随 three.js 一并按 MIT 分发；
  作者署名按官方示例 `webgl_materials_car.html` 页内标注。
- 这是一个真实车型的第三方建模，**仅用于学习交流、不作商业用途**。
  游戏内不使用任何车厂名称与商标，车型在 UI 里只叫“超跑”。
- 同样只做运行时归一化与车漆染色，未修改几何。

### 入库方式

可选车身列表由 `CAR_BODIES`（[src/core/Config.ts](src/core/Config.ts)）定义，
玩家选哪个才下载哪个（`loadCarBody` 按 id 缓存 Promise）。

- `ferrari.glb`（1.6 MB）**入库** —— 它是默认车身，clone 下来就能跑。
- `car.glb`（Car Concept，11 MB）**不入库**，跑 `npm run fetch-car` 拉；
  没拉就选不中“概念车”，不影响其它车身。

## 贴图 / HDRI

_暂无 —— 当前全部为程序化生成。_

## 常用 CC0 资产源（无需署名，可商用可再分发）

- [ambientCG](https://ambientcg.com/) — PBR 材质、HDRI
- [Poly Haven](https://polyhaven.com/) — HDRI、材质、模型（无车辆分类）
- [Khronos glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets) — 逐资产标注许可，CC0 / CC-BY 混合
