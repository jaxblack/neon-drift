# 外部车模

这里的 glTF 车模对应游戏内“车身”选项，列表定义在 `CAR_BODIES`
（[src/core/Config.ts](../../src/core/Config.ts)）。玩家选哪个才下载哪个，
**文件缺失也能正常玩** —— 加载失败会静默退回程序化车模
（`src/render/KartModel.ts`）。

| 文件 | 游戏内名称 | 入库？ |
| --- | --- | --- |
| `ferrari.glb`（1.6 MB） | 超跑（默认） | ✅ 已入库 |
| `car.glb`（11 MB） | 概念车 | ❌ 跑 `npm run fetch-car` 拉 |

新增一个车身 = 把 `.glb` 放进来 + 在 `CAR_BODIES` 里加一行。

## 授权红线

仓库是 **公开 MIT + 公开部署**，往这里放资产前先确认两件事：

1. **模型作者的授权**。CC0 可以直接用；**CC-BY 必须署名** —— 把作者、模型名、
   来源链接、许可协议写进仓库根目录的 `CREDITS.md`，游戏内“操作说明”面板会读它。
2. **车厂的商标和外观设计权**。这一层 **CC-BY 授予不了** —— 上传者本来就没有
   这份权利。本项目是学习交流用途、不商用，UI 里也不出现任何车厂名称；
   若要商用，请换成原创 / 泛化车型。

除 `ferrari.glb` 外的 `.glb` 都在 `.gitignore` 里，不会被误提交。

## 模型约定

不满足也能加载，只是拿不到对应的能力：

| 约定 | 不满足的后果 |
| --- | --- |
| 车头朝 **+Z** | 车会倒着开（长轴朝 X 的会被自动转正，其它情况不会） |
| 车轮贴地，**y=0 为地面** | 会自动按包围盒贴地，一般不用管 |
| 车漆材质名含 `body` / `paint` / `carpaint` / `shell` | 八台车全是同一个颜色，认不出敌我 |
| 轮子节点名含 `wheel`/`tire`/`rim`，且含 `FL`/`FR`/`RL`/`RR`（或 `front`+`left` 之类） | 轮子不转、前轮不跟着方向盘 |

尺寸不用管：加载时会按最长轴等比缩放到车长 4.4m，原点归到车底中心。

## 体积

模型会随首屏一起下载。建议：

- 面数控制在 **10 万三角面以内**（八台车同屏）
- 贴图 2K 以内，用 [gltf-transform](https://gltf-transform.dev/) 压一下：
  ```bash
  npx @gltf-transform/cli optimize in.glb car.glb --texture-compress webp
  ```
- 用了 Draco / KTX2 压缩的话，先跑 `npm run fetch-decoders` 把解码器拷到
  `public/decoders/`（自托管，不依赖 CDN）。没用压缩就不需要。
