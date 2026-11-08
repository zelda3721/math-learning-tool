import { initialState, reduce, type ClassroomEvent, type ClassroomState } from "./machine.js";

/**
 * 课堂会话：把状态机接到播放器上。
 *
 * **只认这几个方法的端口**，不认 `ExplainerPlayer` 这个具体类：
 * 课堂不该知道播放器怎么渲染、有没有 DOM。这样一来——
 * - 它能脱开浏览器测（假播放器即可）；
 * - 将来换成时间轴播放器的另一实现、或者换成一段视频，课堂代码一行不用改。
 *
 * 播放器本身已经有 `seekBeat(i)`（阶段 2 加的），所以真实接线只需要一层薄适配。
 */
export interface BeatPlayer {
  /** 停在某一拍的起点。**不自动播**：能拨的画面应当等学生动手 */
  seekBeat(index: number): void;
  pause?(): void;
}

/**
 * 状态机 → 播放器指令。
 *
 * 只在"该播哪一拍"变了的时候下发：每帧都 seek 会把学生正拨着的滑杆推回去。
 * 返回是否真的下发了指令，便于测试与调试。
 */
export function applyToPlayer(state: ClassroomState, player: BeatPlayer): boolean {
  if (state.phase === "idle" || state.phase === "done") {
    player.pause?.();
    return false;
  }
  // 提问、反馈、小结阶段都停在离开时那一拍：孩子回来时看见的还是原场景
  player.seekBeat(state.beatIndex);
  return true;
}

/**
 * 课堂会话：包一层状态机，每次事件之后把状态同步给播放器。
 *
 * 不在这里做"什么时候该暂停提问"——那是教学策略，属于课堂编排；
 * 这里只保证**状态与画面不各说一套**。
 */
export class ClassroomSession {
  private state: ClassroomState;
  private lastBeat: number | null = null;

  constructor(
    private readonly player: BeatPlayer,
    beatCount: number,
  ) {
    this.state = initialState(beatCount);
  }

  get current(): ClassroomState {
    return this.state;
  }

  /** 收到一个事件，迁移状态并同步播放器 */
  dispatch(event: ClassroomEvent): ClassroomState {
    this.state = reduce(this.state, event);
    if (this.state.beatIndex !== this.lastBeat) {
      this.lastBeat = this.state.beatIndex;
      applyToPlayer(this.state, this.player);
    } else if (this.state.phase === "done" || this.state.phase === "idle") {
      // 拍号没变但阶段结束了：也要让播放器停下来
      applyToPlayer(this.state, this.player);
    }
    return this.state;
  }
}
