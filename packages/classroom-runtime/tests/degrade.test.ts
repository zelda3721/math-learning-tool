import { describe, expect, it } from "vitest";
import { DegradationLog, runStep } from "../src/degrade.js";
import { initialState, reduce } from "../src/machine.js";

/**
 * 失败降级（阶段 3 DoD：TTS、生成、视频各自失败时都能降级）。
 *
 * 用**会失败的桩**验，而不是等线上出故障：这样这条 DoD 是可回归的，
 * 而不是"上线后看运气"。
 */

const boom = () => {
  throw new Error("端点不可达");
};

describe("单步失败不影响流程", () => {
  it("抛错被吞掉，返回 ok:false 与原因", async () => {
    const r = await runStep("tts", boom);
    expect(r).toMatchObject({ step: "tts", ok: false, reason: "端点不可达" });
  });

  it("同步值与 Promise 都能跑", async () => {
    expect((await runStep("generate", () => 42)).value).toBe(42);
    expect((await runStep("video", async () => "ok")).value).toBe("ok");
  });

  it("非 Error 抛出也不炸", async () => {
    const r = await runStep("video", () => {
      throw "字符串异常";
    });
    expect(r.reason).toBe("字符串异常");
  });
});

describe("三个依赖全挂，课照样上完", () => {
  it("语音/生成/视频各自失败 → 仍然从开场走到小结", async () => {
    const log = new DegradationLog();
    let state = initialState(3);
    state = reduce(state, { type: "start" });

    // 每一拍都要过三个依赖，全部失败
    for (let beat = 0; beat < 3; beat += 1) {
      log.record(await runStep("tts", boom));
      log.record(await runStep("generate", boom));
      log.record(await runStep("video", boom));
      state = reduce(state, { type: "beat-finished" });
    }

    expect(state.phase).toBe("summary");
    expect(log.degraded).toBe(true);
    // 如实说明，而且说清"可以继续"——孩子看到的应当是可继续的路径
    expect(log.summary()).toContain("课可以继续上");
  });

  it("只挂语音时说只挂语音，不夸大", async () => {
    const log = new DegradationLog();
    log.record(await runStep("tts", boom));
    log.record(await runStep("generate", () => "内容"));
    expect(log.summary()).toBe("语音这次没能用上，课可以继续上");
  });

  it("没降级时 summary 为 null，界面不必自己判断", async () => {
    const log = new DegradationLog();
    log.record(await runStep("tts", () => "ok"));
    expect(log.degraded).toBe(false);
    expect(log.summary()).toBeNull();
  });
});
