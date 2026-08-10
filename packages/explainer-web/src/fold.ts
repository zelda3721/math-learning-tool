import type { SceneSpec } from "@mathtutor/schema";
import { collectRefs, num } from "./refs.js";

/** 某一拍里一个可见对象的渲染状态 */
export interface RenderObject {
  id: string;
  primitive: string;
  params: Record<string, unknown>;
  label?: string;
  meaning?: string;
  /** 计数类图元的单元数（来自 params.count），非计数类为 undefined */
  count?: number;
  /** 本拍是否被动作触及（appear/take_from/move/highlight/… 都会点亮） */
  emphasis?: boolean;
  /** take_from 累计拿走的单元数（跨拍累计，不清零） */
  removedCount?: number;
}

/** 一拍的完整可见状态（对播放器而言渲染一拍 = 渲染一个 BeatState） */
export interface BeatState {
  index: number;
  teachingLine?: string;
  role?: string;
  objects: RenderObject[];
}

interface ObjState {
  visible: boolean;
  removed: number;
  emphasis: boolean;
}

/**
 * 把 scenes 顺序折叠成逐拍可见状态：
 * - appear/reveal 使对象可见（并 emphasis）
 * - take_from{source,count} 给 source 累计 removedCount 并 emphasis
 * - combine/partition_into/replicate/count/recount_verify/move/transform/highlight 标 emphasis
 * - 未知 op 忽略，但不影响既有可见性
 * - 若整个 spec 没有任何 appear/reveal 动作，则所有对象从第 0 拍可见
 *   （引擎有的计划不写显式 appear）
 * - emphasis 每拍重置（只表示"这一拍正在发生什么"）；removedCount 跨拍累计
 */
export function foldBeats(spec: SceneSpec): BeatState[] {
  const objects = spec.visual_objects;
  const hasAppear = spec.scenes.some((beat) =>
    beat.actions.some((a) => a.op === "appear" || a.op === "reveal"),
  );

  const state = new Map<string, ObjState>();
  for (const obj of objects) {
    state.set(obj.id, { visible: !hasAppear, removed: 0, emphasis: false });
  }

  const snapshot = (index: number, teachingLine?: string, role?: string): BeatState => ({
    index,
    ...(teachingLine !== undefined ? { teachingLine } : {}),
    ...(role !== undefined ? { role } : {}),
    objects: objects
      .filter((obj) => state.get(obj.id)?.visible)
      .map((obj) => {
        const st = state.get(obj.id)!;
        const count = num((obj.params as Record<string, unknown>).count, Number.NaN);
        const render: RenderObject = {
          id: obj.id,
          primitive: obj.primitive,
          params: obj.params as Record<string, unknown>,
        };
        if (obj.label !== undefined) render.label = obj.label;
        if (obj.meaning !== undefined) render.meaning = obj.meaning;
        if (Number.isFinite(count)) render.count = count;
        if (st.emphasis) render.emphasis = true;
        if (st.removed > 0) render.removedCount = st.removed;
        return render;
      }),
  });

  // 没有任何 scene：仍给一拍全可见（引擎极简计划兜底），无对象则返回空
  if (spec.scenes.length === 0) {
    if (objects.length === 0) return [];
    for (const st of state.values()) st.visible = true;
    return [snapshot(0)];
  }

  const beats: BeatState[] = [];
  spec.scenes.forEach((beat, index) => {
    for (const st of state.values()) st.emphasis = false;

    for (const action of beat.actions) {
      const refs = collectRefs(action);
      const touch = (mutate?: (st: ObjState) => void) => {
        for (const ref of refs) {
          const st = state.get(ref);
          if (!st) continue;
          st.emphasis = true;
          mutate?.(st);
        }
      };

      switch (action.op) {
        case "appear":
        case "reveal":
          touch((st) => {
            st.visible = true;
          });
          break;
        case "take_from": {
          const rec = action as Record<string, unknown>;
          const source = typeof rec.source === "string" ? rec.source : refs[0];
          const st = source !== undefined ? state.get(source) : undefined;
          if (st) {
            st.removed += Math.max(0, num(rec.count, 1));
            st.emphasis = true;
          }
          break;
        }
        case "combine":
        case "partition_into":
        case "replicate":
        case "count":
        case "recount_verify":
        case "move":
        case "highlight":
        case "transform":
          touch();
          break;
        default:
          // 未知 op：忽略，但保持可见性不被破坏
          break;
      }
    }

    if (beat.attention_target !== undefined) {
      const st = state.get(beat.attention_target);
      if (st) st.emphasis = true;
    }

    beats.push(snapshot(index, beat.teaching_line, beat.role));
  });

  return beats;
}
