# 第三方资产署名

游戏本体（代码、程序化几何体、程序化贴图、程序化音效）是 MIT，见 [LICENSE](LICENSE)。

本文件登记引入的第三方美术资产。**CC-BY 类资产的署名是许可协议的强制要求，
不是可选项** —— 用了就必须在这里登记，删掉署名等于违约。

## 车模

| 资产 | 作者 | 来源 | 许可 |
| --- | --- | --- | --- |
| Car Concept | © 2024 Darmstadt Graphics Group GmbH；模型与贴图作者 Eric Chadwick | [KhronosGroup/glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode) |

补充说明：

- 该资产改编自 Unity Fan 发布的 **CC0（公共领域）** 概念车模型。
  它是**原创概念车，不是任何真实车型的复刻**，因此不涉及车厂的商标或外观设计权。
- 模型车尾牌照及方向盘上带有 **Khronos / 3D Commerce 徽标**。按上游 README，
  这些属于 "Khronos Trademark or Logo"（不受版权保护的徽标），随资产一同分发。
- 本项目未修改该资产的几何，仅在运行时做了归一化（等比缩放、贴地、朝向）、
  按阵营色替换车漆材质颜色、隐藏内饰网格以降低 draw call。
- 文件本身不入库（见 `.gitignore`），由 `public/models/manifest.json` 开关启用。

## 贴图 / HDRI

_暂无 —— 当前全部为程序化生成。_

## 常用 CC0 资产源（无需署名，可商用可再分发）

- [ambientCG](https://ambientcg.com/) — PBR 材质、HDRI
- [Poly Haven](https://polyhaven.com/) — HDRI、材质、模型（无车辆分类）
- [Khronos glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets) — 逐资产标注许可，CC0 / CC-BY 混合
