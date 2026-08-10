import { describe, expect, it } from "vitest";
import { ExplainerPlayer } from "../src/player.js";

/**
 * 有意不做 DOM/渲染测试：happy-dom / jsdom 都是第三方依赖（本包硬性要求零第三方依赖），
 * 而在 node 环境手工 mock document/SVG/WAAPI 的成本远超收益。
 * 播放器的渲染正确性由 apps/web 集成后在真实浏览器验证；
 * 这里只冒烟确认模块可在 node 下安全 import（类定义不在模块顶层碰 DOM 全局）。
 */
describe("ExplainerPlayer (smoke, no DOM)", () => {
  it("exports a constructable class with the contract surface", () => {
    expect(typeof ExplainerPlayer).toBe("function");
    for (const method of ["play", "pause", "next", "prev", "goTo", "destroy"]) {
      expect(typeof ExplainerPlayer.prototype[method as keyof ExplainerPlayer]).toBe("function");
    }
  });
});
