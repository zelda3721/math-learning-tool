import { describe, expect, it } from "vitest";
import { ExplainerPlayer } from "../src/player.js";

/**
 * 有意不做 DOM/渲染测试：本包硬性要求零第三方依赖，在 node 环境手工 mock
 * document/SVG/WAAPI 的成本远超收益。渲染的确定性由 timeline.test.ts
 * 在**纯函数层**钉住（同一 t 两次求值逐字段相等），浏览器里再由截图对比兜底。
 *
 * 这里只确认公开面没被改坏——合约破了，调用方会在运行时才发现。
 */
describe("ExplainerPlayer (smoke, no DOM)", () => {
  it("exports a constructable class with the contract surface", () => {
    expect(typeof ExplainerPlayer).toBe("function");
    for (const method of ["play", "pause", "next", "prev", "goTo", "destroy"] as const) {
      expect(typeof ExplainerPlayer.prototype[method]).toBe("function");
    }
  });

  it("阶段 2 新增的时间轴接口在册：seek / seekBeat / duration / currentTime", () => {
    expect(typeof ExplainerPlayer.prototype.seek).toBe("function");
    expect(typeof ExplainerPlayer.prototype.seekBeat).toBe("function");
    for (const accessor of ["duration", "currentTime"]) {
      const desc = Object.getOwnPropertyDescriptor(ExplainerPlayer.prototype, accessor);
      expect(desc?.get, `${accessor} 应该是 getter`).toBeTypeOf("function");
    }
  });
});
