// Adapted from OpenMAIC lib/playback/auto-resume.ts @795420c1 (MIT)
//
// 移植说明：只搬家算法，类型层换成本项目自己的形状（见 ./action.ts）。
// 上游这套逻辑围着"演讲/观众席"的语义长，迁到课堂语义时若有改动，
// 会在改动处单独注明为什么。未改动处保持原样便于与上游对账。

import type { EngineMode } from "./types.js";

/**
 * Where a chat-session cleanup originated. A confirmed or timed-out soft close
 * may auto-resume an interrupted lecture; other sources must not.
 */
export type CleanupSource =
  | 'soft_close_enter'
  | 'soft_close_confirmed'
  | 'soft_close_timeout'
  | 'manual_stop'
  | 'scene_switch'
  | 'error'
  | 'turn_complete';

export interface AutoResumeArgs {
  /** Which cleanup path is running. */
  source: CleanupSource;
  /** Director-provided reason the Q&A/discussion ended, if any. */
  endReason?: string;
  /** Whether this session interrupted an active lecture (read before cleanup). */
  hadLectureInterruption: boolean;
  /** Engine mode AFTER cleanup restored the saved lecture position. */
  engineMode: EngineMode;
  /** Whether the course has no more content to play. */
  isExhausted: boolean;
  /** Whether playback already reached completion. */
  playbackCompleted: boolean;
}

/**
 * Decide whether an ended Q&A/discussion should auto-resume the lecture it
 * interrupted. Pure and conservative: it only returns true for the narrow
 * "completed soft close after a satisfied/back-to-lesson Q&A" case, and
 * requires the engine to be idle with content still remaining.
 */
export function shouldAutoResumeLecture(args: AutoResumeArgs): boolean {
  if (args.source !== 'soft_close_confirmed' && args.source !== 'soft_close_timeout') return false;
  if (!args.hadLectureInterruption) return false;
  if (args.endReason !== 'user_done' && args.endReason !== 'back_to_lesson') return false;
  if (args.engineMode !== 'idle') return false;
  if (args.isExhausted || args.playbackCompleted) return false;
  return true;
}
