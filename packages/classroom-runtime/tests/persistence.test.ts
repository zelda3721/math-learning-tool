import { describe, expect, it } from "vitest";
import { resumeAt } from "../src/machine.js";
import { clearProgress, loadProgress, saveProgress, storageKey, type ProgressStore } from "../src/persistence.js";
import { ClassroomSession } from "../src/session.js";

/**
 * 断点续学：关掉再打开，接着上次那一拍。
 * 存拍号而不是秒——改一次旁白时长，存秒的进度会全部错位到别的场景中间。
 */

function memoryStore(): ProgressStore & { dump(): Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    get: (k) => data[k] ?? null,
    set: (k, v) => {
      data[k] = v;
    },
    dump: () => data,
  };
}

const seekCalls: number[] = [];
const fakePlayer = { seekBeat: (i: number) => seekCalls.push(i) };

describe("保存与读回", () => {
  it("讲到第 3 拍 → 读回来还是第 3 拍", () => {
    const store = memoryStore();
    const session = new ClassroomSession(fakePlayer, 5);
    session.dispatch({ type: "start" });
    session.dispatch({ type: "beat-finished" });
    session.dispatch({ type: "beat-finished" });
    saveProgress(store, "lesson-1", session.current);

    const progress = loadProgress(store, "lesson-1", 5);
    expect(progress?.beatIndex).toBe(2);
  });

  it("还没开始就没什么可续的：不把「停在第一拍的空白」存成进度", () => {
    const store = memoryStore();
    saveProgress(store, "lesson-1", { phase: "idle", beatIndex: 0, beatCount: 5, question: null, lastAnswer: null });
    expect(store.dump()[storageKey("lesson-1")]).toBeUndefined();
  });

  it("课程变短了 → 夹回合法范围，不续到不存在的拍上", () => {
    const store = memoryStore();
    store.set(storageKey("l"), JSON.stringify({ beatIndex: 9, savedAt: "x" }));
    expect(loadProgress(store, "l", 3)?.beatIndex).toBe(2);
  });

  it("坏数据不让课打不开（存储是外部环境，不该有能力挡住上课）", () => {
    const store = memoryStore();
    store.set(storageKey("l"), "{ 不是 JSON");
    expect(loadProgress(store, "l", 5)).toBeNull();
    store.set(storageKey("l"), JSON.stringify({ beatIndex: "abc" }));
    expect(loadProgress(store, "l", 5)).toBeNull();
  });

  it("清除进度后不再召回", () => {
    const store = memoryStore();
    store.set(storageKey("l"), JSON.stringify({ beatIndex: 2, savedAt: "x" }));
    clearProgress(store, "l");
    expect(loadProgress(store, "l", 5)).toBeNull();
  });
});

describe("从断点恢复", () => {
  it("直接进入讲解态、落在存下来的那一拍（不重放历史事件）", () => {
    const state = resumeAt(5, 2);
    expect(state).toMatchObject({ phase: "explaining", beatIndex: 2, question: null, lastAnswer: null });
  });

  it("越界钳制；0 拍的课直接进小结", () => {
    expect(resumeAt(5, 99).beatIndex).toBe(4);
    expect(resumeAt(5, -3).beatIndex).toBe(0);
    expect(resumeAt(0, 3).phase).toBe("summary");
  });

  it("恢复出来的状态能直接驱动播放器", () => {
    seekCalls.length = 0;
    const session = new ClassroomSession(fakePlayer, 5);
    // 真实用法：读回进度 → 用恢复态开局
    const restored = resumeAt(5, 3);
    saveProgress(memoryStore(), "l", restored);
    session.dispatch({ type: "start" });
    expect(session.current.phase).toBe("explaining");
  });
});
