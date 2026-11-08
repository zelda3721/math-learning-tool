// Adapted from OpenMAIC lib/playback/action-navigation.ts @795420c1 (MIT)
//
// 移植说明：只搬家算法，类型层换成本项目自己的形状（见 ./action.ts）。
// 上游这套逻辑围着"演讲/观众席"的语义长，迁到课堂语义时若有改动，
// 会在改动处单独注明为什么。未改动处保持原样便于与上游对账。

import type { PlaybackAction as Action } from "./action.js";

export interface ActionNavigationTarget {
  actionIndex: number;
  actionId: string;
  actionType: Action['type'];
  lineNumber: number;
  canJump: boolean;
}

export interface ActionLineProgress {
  currentLine: number;
  totalLines: number;
}

const UNSAFE_ACTION_TYPES = new Set<Action['type']>([
  'play_video',
  'discussion',
  'widget_highlight',
  'widget_setState',
  'widget_annotation',
  'widget_reveal',
]);

const WHITEBOARD_ACTION_TYPES = new Set<Action['type']>([
  'wb_open',
  'wb_draw_text',
  'wb_draw_shape',
  'wb_draw_chart',
  'wb_draw_latex',
  'wb_draw_table',
  'wb_draw_line',
  'wb_draw_code',
  'wb_edit_code',
  'wb_clear',
  'wb_delete',
  'wb_close',
]);

export function isUnsafePlaybackNavigationAction(action: Action): boolean {
  return UNSAFE_ACTION_TYPES.has(action.type);
}

export function isWhiteboardPlaybackAction(action: Action): boolean {
  return WHITEBOARD_ACTION_TYPES.has(action.type);
}

/** Only the contiguous visual cues immediately before a speech belong to its replay. */
export function getSpeechVisualCueStartIndex(
  actions: readonly Action[],
  speechIndex: number,
): number {
  let start = speechIndex;
  while (start > 0) {
    const type = actions[start - 1]?.type;
    if (type !== 'spotlight' && type !== 'laser') break;
    start--;
  }
  return start;
}

export function canReconstructPrefixForAction(
  actions: readonly Action[],
  actionIndex: number,
): boolean {
  if (!Number.isInteger(actionIndex) || actionIndex < 0 || actionIndex >= actions.length) {
    return false;
  }
  if (actions[actionIndex]?.type !== 'speech') return false;

  for (let i = 0; i < actionIndex; i++) {
    if (isUnsafePlaybackNavigationAction(actions[i]!)) {
      return false;
    }
  }
  return true;
}

export function canJumpWithinReconstructablePrefix(
  actions: readonly Action[],
  currentActionIndex: number | null | undefined,
  targetActionIndex: number,
): boolean {
  if (!canReconstructPrefixForAction(actions, targetActionIndex)) return false;
  const currentLimit = Math.min(actions.length, Math.max(0, currentActionIndex ?? 0));
  for (let i = 0; i < currentLimit; i++) {
    if (isUnsafePlaybackNavigationAction(actions[i]!)) {
      return false;
    }
  }
  return true;
}

export function buildActionNavigationTargets(actions: readonly Action[]): ActionNavigationTarget[] {
  let lineNumber = 0;
  return actions.flatMap((action, actionIndex) => {
    if (action.type !== 'speech') return [];
    lineNumber += 1;
    return [
      {
        actionIndex,
        actionId: action.id,
        actionType: action.type,
        lineNumber,
        canJump: canReconstructPrefixForAction(actions, actionIndex),
      },
    ];
  });
}

export function getActionLineProgress(
  actions: readonly Action[],
  currentActionIndex: number | null | undefined,
): ActionLineProgress {
  const targets = buildActionNavigationTargets(actions);
  if (targets.length === 0) {
    return { currentLine: 0, totalLines: 0 };
  }

  const cursor = Math.max(0, currentActionIndex ?? 0);
  const exactOrPrevious = [...targets].reverse().find((target) => target.actionIndex <= cursor);
  // noUncheckedIndexedAccess：targets 非空已在上面的早返回里判过
  const currentLine = exactOrPrevious?.lineNumber ?? targets[0]!.lineNumber;
  return { currentLine, totalLines: targets.length };
}

export function getPreviousSafeSpeechActionIndex(
  actions: readonly Action[],
  currentActionIndex: number | null | undefined,
): number | null {
  const cursor = Math.max(0, currentActionIndex ?? 0);
  const target = [...buildActionNavigationTargets(actions)]
    .reverse()
    .find((candidate) => candidate.canJump && candidate.actionIndex < cursor);
  return target?.actionIndex ?? null;
}

export function getNextSafeSpeechActionIndex(
  actions: readonly Action[],
  currentActionIndex: number | null | undefined,
): number | null {
  const cursor = Math.max(0, currentActionIndex ?? 0);
  const target = buildActionNavigationTargets(actions).find(
    (candidate) => candidate.canJump && candidate.actionIndex > cursor,
  );
  return target?.actionIndex ?? null;
}
