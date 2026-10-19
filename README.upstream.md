# Ink Runner — 计算图形学课程项目（开发中）

这是基于开源项目 [three-fluid-fx](https://github.com/artcodev/three-fluid-fx) 修改的交互式流体与粒子实验。当前目标是在 **2D 运动平面**上控制一个**可见的 3D 球体**，让球运动时向 GPU 流体速度场施加扰动，观察粒子的响应及恢复。

> 当前为课程项目原型，并非完成版游戏；交互强度、球体大小与流体作用范围的映射仍在调试。

## 1. 给新同学：快速运行

**需要：** Node.js、pnpm、支持 WebGL2 的 Chrome/Edge 浏览器。推荐用 VS Code 打开整个项目文件夹。

在项目根目录（包含 `package.json` 的目录）打开终端：

```powershell
npm.cmd install -g pnpm   # 已安装 pnpm 可跳过
pnpm.cmd install
pnpm.cmd dev
```

开发服务器默认地址：`http://127.0.0.1:4321/`

**重点查看目前改造的页面：**

`http://127.0.0.1:4321/examples/glsl/full/particles-2d/`

如果 PowerShell 无法运行 `pnpm`，请使用 `pnpm.cmd`。启动终端需要保持运行。安装时若提示忽略 `esbuild` 或 `sharp` 的构建脚本，可按提示运行 `pnpm.cmd approve-builds`，核对包名后批准，再运行 `pnpm.cmd install`。

## 2. 操作方法

- **W / A / S / D** 或 **方向键**：移动玩家球体（需要网页获得键盘焦点）。
- **鼠标移动**：沿用原示例的指针流体扰动交互。
- 右侧 **Player Ball** 参数面板（以当前实际运行的版本为准）：
  - `ball size`：玩家球体大小。
  - `stir force`：球运动产生的扰动强度。
  - `flow radius ×`：球体扰动的空间范围（若当前版本包含）。
  - `size affects flow`：启用球体尺寸与扰动范围的联动（若当前版本包含）。
- 原有 **Particle physics** 分组含 `spring`、`zeta` 等参数，用于调节粒子的回聚和阻尼效果。

## 3. 主要代码位置

| 路径 | 用途 |
| --- | --- |
| `examples/glsl/full/particles-2d/main.ts` | **当前主要开发入口**；玩家球体、输入处理、参数面板、流场扰动与渲染接入 |
| `examples/glsl/full/particles-3d/main.ts` | 官方三维粒子示例；此前可能做过测试性修改，**不是当前主要开发入口** |
| `examples/extras/particles/glsl/flowParticles.ts` | 官方示例级 GPGPU 粒子求解与绘制、弹簧恢复和阻尼 |
| `src/` | `three-fluid-fx` 流体库相关实现 |
| `package.json` | 依赖、启动脚本和构建命令 |

建议先阅读 `particles-2d/main.ts` 中的 `FluidSimulation`、`createFlowParticles`、`fluid.addSplat`、`particles.step`，再追踪到粒子求解代码。

## 4. 当前技术思路

1. 使用 Three.js 绘制玩家球体；球体模型可以是三维的，但运动约束在屏幕 XY 平面。
2. 使用 `FluidSimulation` 管理 GPU 二维速度场。
3. 根据球体移动向流场注入 `addSplat(x, y, dx, dy)` 扰动；当前正在探索**球心点式**与**球体接触区域分布式**两种方式。
4. `createFlowParticles(..., { mode: 'plane2d' })` 使用速度纹理驱动粒子，并通过弹簧/阻尼使粒子朝目标分布恢复。
5. 粒子的恢复不等于墨水染料纹理逆向恢复；目前的流固交互是**视觉近似**，不是精确的刚体–流体双向物理耦合。

## 5. 接下来要做什么

- [ ] 统一球体大小、接触面积、扰动力的单位与映射，避免“大球反而扰动更小”。
- [ ] 增加点式 / 区域式扰动切换，做可重复的视觉对照。
- [ ] 设计矩形平面赛道、边界反馈和更完整的视觉表现。
- [ ] 记录 FPS、不同球体半径和扰动参数下的响应，用于课程实验。
- [ ] 清理之前的临时修复脚本与备份文件，保留可复现版本。

## 6. 分享项目注意事项

**建议传递项目源码，不要把整个 `node_modules/` 打包给同学。** 依赖会通过 `pnpm.cmd install` 重建，`node_modules` 体积大、且可能受操作系统影响。还可以排除 `.git/`、`dist/`、`.astro/` 等缓存或构建产物（若不打算保留 Git 提交历史）。

务必保留 `package.json`、锁文件 `pnpm-lock.yaml`（如有）、`examples/`、`src/`、配置文件以及上游仓库的 `LICENSE` / 第三方许可说明。不要打包个人账号凭据、`.env` 等敏感文件。

**注意：** 由于我们之前多次用补丁覆盖 `main.ts`，请在发送前**在你自己电脑上确认 2D 页面能打开、球体可见、参数能变化**。这份 README 解释的是项目方向及已讨论的功能，不代表每个未验证功能在当前版本都已正确实现。

## 7. 项目来源与许可

本项目基于 [artcodev/three-fluid-fx](https://github.com/artcodev/three-fluid-fx)（MIT License）进行课程实验与二次开发。请保留原项目版权及许可文件；本项目修改部分应与原作者实现区分。
