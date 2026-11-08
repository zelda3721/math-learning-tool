import { describe, expect, it } from "vitest";
import { canTransition, initialState, reduce, type ClassroomState } from "../src/machine.js";

/**
 * 课堂状态机。验的是阶段 3 DoD 里那三条可以脱离浏览器验证的：
 * 断点续学、提问后回到原场景、非法事件不崩。
 */

const run = (state: ClassroomState, events: Parameters<typeof reduce>[1][]) =>
  events.reduce(reduce, state);

describe("一节完整的课", () => {
  it("开始 → 逐拍推进 → 讲完最后一拍进小结 → 结束", () => {
    let s = initialState(3);
    expect(s.phase).toBe("idle");

    s = reduce(s, { type: "start" });
    expect(s).toMatchObject({ phase: "explaining", beatIndex: 0 });

    s = reduce(s, { type: "beat-finished" });
    expect(s.beatIndex).toBe(1);
    s = reduce(s, { type: "beat-finished" });
    expect(s.beatIndex).toBe(2);

    s = reduce(s, { type: "beat-finished" });
    expect(s.phase).toBe("summary");
    // 讲完不是"停在最后一拍却说自己结束了"：拍号停在最后一拍，阶段进小结
    expect(s.beatIndex).toBe(2);

    s = reduce(s, { type: "finish" });
    expect(s.phase).toBe("done");
  });

  it("0 拍的课也能收尾，不越界", () => {
    const s = run(initialState(0), [{ type: "start" }, { type: "beat-finished" }]);
    expect(s.phase).toBe("summary");
    expect(s.beatIndex).toBe(0); // 负数拍号会让"续学"恢复出一个不存在的位置
  });
});

describe("提问与回到原场景", () => {
  it("暂停提问不推进拍号；答完回到**离开时那一拍**", () => {
    let s = initialState(5);
    s = run(s, [{ type: "start" }, { type: "beat-finished" }, { type: "beat-finished" }]);
    expect(s.beatIndex).toBe(2);

    s = reduce(s, { type: "pause-question", question: "你觉得下一步会怎样？" });
    expect(s).toMatchObject({ phase: "awaiting-answer", beatIndex: 2 });
    expect(s.question).toBe("你觉得下一步会怎样？");

    s = reduce(s, { type: "answer", correct: true });
    expect(s).toMatchObject({ phase: "feedback", lastAnswer: { correct: true } });

    s = reduce(s, { type: "resume" });
    expect(s).toMatchObject({ phase: "explaining", beatIndex: 2, question: null });
  });

  it("提问中也能直接回到讲解（孩子选择跳过），拍号同样不变", () => {
    let s = run(initialState(3), [{ type: "start" }, { type: "beat-finished" }]);
    s = reduce(s, { type: "pause-question", question: "?" });
    s = reduce(s, { type: "resume" });
    expect(s).toMatchObject({ phase: "explaining", beatIndex: 1 });
  });
});

describe("非法迁移", () => {
  it("状态不变，不抛异常（长期运行的课堂不该被一次重复事件弄崩）", () => {
    const s = initialState(3);
    // 还没开始就收尾
    expect(reduce(s, { type: "finish" })).toBe(s);
    // 没在提问却交答案
    expect(reduce(run(s, [{ type: "start" }]), { type: "answer", correct: true })).toEqual(
      run(s, [{ type: "start" }]),
    );
  });

  it("canTransition 与 reducer 的判断一致（UI 置灰与真实行为不会各说一套）", () => {
    const s = run(initialState(3), [{ type: "start" }]);
    for (const type of ["start", "beat-finished", "pause-question", "answer", "finish"] as const) {
      const allowed = canTransition(s.phase, type);
      const moved = reduce(s, type === "pause-question" ? { type, question: "q" } : type === "answer" ? { type, correct: true } : { type }) !== s;
      expect(moved).toBe(allowed);
    }
  });
});
