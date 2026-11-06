import { describe, expect, it } from "vitest";
import { ClassroomSession, type BeatPlayer } from "../src/session.js";

/**
 * 课堂 ↔ 播放器的接线。用假播放器测，不碰浏览器：
 * 课堂只该关心"该停在第几拍"，不该关心怎么画。
 */

function fakePlayer() {
  const calls: string[] = [];
  const player: BeatPlayer = {
    seekBeat: (i) => calls.push(`seek:${i}`),
    pause: () => calls.push("pause"),
  };
  return { player, calls };
}

describe("课堂驱动播放器", () => {
  it("开始上课 → 播放器停在第一拍", () => {
    const { player, calls } = fakePlayer();
    new ClassroomSession(player, 3).dispatch({ type: "start" });
    expect(calls).toEqual(["seek:0"]);
  });

  it("每讲完一拍 → 播放器跟着走一拍", () => {
    const { player, calls } = fakePlayer();
    const s = new ClassroomSession(player, 3);
    s.dispatch({ type: "start" });
    s.dispatch({ type: "beat-finished" });
    s.dispatch({ type: "beat-finished" });
    expect(calls).toEqual(["seek:0", "seek:1", "seek:2"]);
  });

  it("暂停提问 → **不**再下发 seek：画面停在原处等孩子答", () => {
    const { player, calls } = fakePlayer();
    const s = new ClassroomSession(player, 3);
    s.dispatch({ type: "start" });
    s.dispatch({ type: "beat-finished" });
    calls.length = 0;

    s.dispatch({ type: "pause-question", question: "你觉得呢？" });
    expect(calls).toEqual([]); // 拍号没变，不该把画面推走
    expect(s.current.phase).toBe("awaiting-answer");
  });

  it("结束 → 播放器暂停", () => {
    const { player, calls } = fakePlayer();
    const s = new ClassroomSession(player, 1);
    s.dispatch({ type: "start" });
    s.dispatch({ type: "beat-finished" }); // → summary
    calls.length = 0;
    s.dispatch({ type: "finish" }); // → done
    expect(calls).toEqual(["pause"]);
  });

  it("同一拍上重复事件不会反复 seek（别把学生正拨着的滑杆推回去）", () => {
    const { player, calls } = fakePlayer();
    const s = new ClassroomSession(player, 3);
    s.dispatch({ type: "start" });
    calls.length = 0;
    s.dispatch({ type: "pause-question", question: "?" });
    s.dispatch({ type: "resume" });
    expect(calls).toEqual([]);
  });
});
