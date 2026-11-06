/**
 * 课堂状态机（纯函数，零 DOM）。
 *
 * 为什么先写它而不是先搬播放引擎：课堂的 DoD 是「断点续学、提问后能回到原场景、
 * 各环节失败都能降级」——这三条全是状态机的事，跟播放引擎多强大没关系。
 *
 * 形态：
 *
 *   idle ──start──▶ explaining ──beat-finished──▶ explaining …
 *                        │                              │
 *                        │ pause-question               │ 最后一拍
 *                        ▼                              ▼
 *                 awaiting-answer ──answer──▶ feedback   summary ──finish──▶ done
 *                        │                      │
 *                        │ resume               │ next-beat
 *                        ▼                      ▼
 *                    explaining ◀──────────────┘
 *
 * 三条设计上的取舍：
 *
 * 1. **回到的永远是"哪一拍"，不是"第几秒"。** 拍是讲解的结构单位，秒是渲染的细节；
 *    续学时按秒恢复，中途改了旁白时长就会错位，而按拍恢复不会。
 * 2. **暂停提问不推进拍号。** 孩子答完回来看见的还是他离开时那一拍——
 *    这是 DoD 里"提问后能回到原场景"的字面意思。
 * 3. **非法迁移不抛异常，原样返回。** 课堂是长期运行的状态机，一次意外的
 *    重复事件（比如进度条早触发了一次 beat-finished）不该让整节课崩掉。
 *    合法与否由 `canTransition` 单独给出，便于 UI 置灰按钮。
 */

export type ClassroomPhase =
  | "idle"
  | "explaining"
  | "awaiting-answer"
  | "feedback"
  | "summary"
  | "done";

export interface ClassroomState {
  phase: ClassroomPhase;
  /** 当前正在讲的拍（0 起）；不在 explaining 时表示"回到这里" */
  beatIndex: number;
  beatCount: number;
  /** 暂停提问时记下问题；不在 awaiting-answer 时为 null */
  question: string | null;
  /** 最近一次作答的结果，供 feedback 阶段展示 */
  lastAnswer: { correct: boolean } | null;
}

export type ClassroomEvent =
  | { type: "start" }
  /** 一拍讲完；最后一拍会转到 summary */
  | { type: "beat-finished" }
  | { type: "pause-question"; question: string }
  | { type: "answer"; correct: boolean }
  /** 从反馈/提问回到讲解，落在离开时那一拍 */
  | { type: "resume" }
  | { type: "finish" };

export function initialState(beatCount: number): ClassroomState {
  return {
    phase: "idle",
    beatIndex: 0,
    beatCount: Math.max(0, Math.floor(beatCount)),
    question: null,
    lastAnswer: null,
  };
}

/** 合法迁移表。UI 要置灰按钮、要防误触，问这里；reducer 自己用它兜底 */
const ALLOWED: Record<ClassroomPhase, ClassroomEvent["type"][]> = {
  idle: ["start"],
  explaining: ["beat-finished", "pause-question", "finish"],
  "awaiting-answer": ["answer", "resume"],
  feedback: ["resume", "finish"],
  summary: ["finish"],
  done: [],
};

export function canTransition(phase: ClassroomPhase, event: ClassroomEvent["type"]): boolean {
  return ALLOWED[phase].includes(event);
}

/**
 * 走一步。非法迁移原样返回（见文件头的第 3 条取舍）。
 */
export function reduce(state: ClassroomState, event: ClassroomEvent): ClassroomState {
  if (!canTransition(state.phase, event.type)) return state;

  switch (event.type) {
    case "start":
      return {
        ...state,
        phase: "explaining",
        beatIndex: 0,
        question: null,
        lastAnswer: null,
      };

    case "beat-finished": {
      const next = state.beatIndex + 1;
      // 讲完最后一拍进小结，而不是停在最后一拍上"讲完了但没结束"
      // 0 拍的课：拍号停在 0 而不是 -1（负数拍号会让"续学"恢复出一个不存在的位置）
      if (next >= state.beatCount)
        return { ...state, phase: "summary", beatIndex: Math.max(0, state.beatCount - 1) };
      return { ...state, beatIndex: next };
    }

    case "pause-question":
      // 拍号**不动**：答完回来还是这一拍
      return { ...state, phase: "awaiting-answer", question: event.question };

    case "answer":
      return {
        ...state,
        phase: "feedback",
        lastAnswer: { correct: event.correct },
        question: null,
      };

    case "resume":
      return { ...state, phase: "explaining", question: null };

    case "finish":
      return { ...state, phase: "done", question: null };

    default:
      return state;
  }
}
