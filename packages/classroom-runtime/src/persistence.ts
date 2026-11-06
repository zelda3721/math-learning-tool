import type { ClassroomState } from "./machine.js";

/**
 * 断点续学：关掉再打开，接着上次那一拍。
 *
 * 存的是**拍号**，不是播放时刻。拍是讲解的结构单位，秒是渲染细节——
 * 存秒的话，改一次旁白时长，所有历史进度都会错位到别的场景中间。
 *
 * 只存最少的东西：拍号与时间戳。存整份状态会把"那一刻的临时 UI 状态"
 * 也腌进去，而那些东西恢复出来反而错（比如正等着孩子回答的那道题，
 * 重新打开时该重问一遍，而不是恢复成"已提问"的半截状态）。
 */

export interface ClassroomProgress {
  beatIndex: number;
  /** 保存时刻（ISO），用于将来做过期策略与"上次学到哪儿"的展示 */
  savedAt: string;
}

export interface ProgressStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** 浏览器里用 localStorage；测试里用假 store。课堂本身不认识 localStorage */
export function storageKey(lessonKey: string): string {
  return `mathtutor:classroom:${lessonKey}`;
}

export function saveProgress(store: ProgressStore, lessonKey: string, state: ClassroomState): void {
  // 还没开始讲课就没什么可续的，别把"停在第一拍的空白"存成进度
  if (state.phase === "idle") return;
  const progress: ClassroomProgress = {
    beatIndex: state.beatIndex,
    savedAt: new Date().toISOString(),
  };
  store.set(storageKey(lessonKey), JSON.stringify(progress));
}

/**
 * 读回进度。读不出来一律返回 null——**坏数据不能让课打不开**：
 * 存储是外部环境（用户清过缓存、版本升级改过格式），它不该有能力挡住上课。
 */
export function loadProgress(
  store: ProgressStore,
  lessonKey: string,
  beatCount: number,
): ClassroomProgress | null {
  const raw = store.get(storageKey(lessonKey));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ClassroomProgress>;
    const index = Number(parsed.beatIndex);
    if (!Number.isFinite(index)) return null;
    // 课程内容变短了：夹回合法范围，而不是续到一个不存在的拍上
    const clamped = Math.max(0, Math.min(Math.max(0, beatCount - 1), Math.floor(index)));
    return {
      beatIndex: clamped,
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/** 清掉进度（家长重置、课程内容大改时用） */
export function clearProgress(store: ProgressStore, lessonKey: string): void {
  store.set(storageKey(lessonKey), "");
}
