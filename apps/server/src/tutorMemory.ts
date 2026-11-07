import type { GraphIndex } from "@mathtutor/knowledge";
import type { Repo } from "./repo.js";

/**
 * 导师长期记忆：导师"记住了什么"，必须是**可解释、可删、只存本地**的。
 *
 * 三条设计决定，都为了同一个目的——家长能看懂并在需要时抹掉：
 *
 * 1. **记忆是推导出来的，不是模型自由写出来的**。当前全部来自可数的事实
 *    （这个节点错过几次、哪些节点点亮了、孩子自己填的兴趣），每条都带着它从哪来。
 *    让模型自由生成"这孩子缺乏专注力"这种话，既不可验证也不该被长期保存。
 * 2. **同一件事只记一条**（dedupe_key + 计数）。人的记忆是"他在分数上老出错"，
 *    不是"他在分数上出错了第 7 次"。
 * 3. **删了就真的不再被召回**：软删除后所有读取路径都过滤，审计上保留"曾有一条、
 *    何时被删"。删除是家长的权利，不是建议。
 */

export type MemoryKind = "struggle" | "strength" | "preference" | "goal";

export interface LearnerProfile {
    /** 孩子自己说过的兴趣（用来出题的素材） */
    interests: string[];
    /** 近期目标（例如"学会通分"）*/
    goals: string[];
    /** 更吃图形还是更吃式子；null 表示还没观察出来 */
    prefersVisual: boolean | null;
}

/** 派生阈值：同一个节点至少错这么多次才算"卡住" */
const STRUGGLE_MIN_COUNT = 2;

/**
 * 从已有数据推导记忆（幂等：重复跑不会堆出重复条目）。
 *
 * 用错因记录与掌握度，而不是"聊天里说过什么"——后者要模型判断，
 * 而模型判断的东西不该被当成长期事实存下来。
 */
export function deriveMemories(repo: Repo, index: GraphIndex, learnerId: string): void {
    const nameOf = (nodeId: string) => index.nodeById.get(nodeId)?.name ?? nodeId;

    // 卡住：按根因节点聚合错因
    const byRoot = new Map<string, number>();
    for (const mistake of repo.listMistakes(learnerId, 200)) {
        byRoot.set(mistake.rootNodeId, (byRoot.get(mistake.rootNodeId) ?? 0) + 1);
    }
    for (const [nodeId, count] of byRoot) {
        if (count < STRUGGLE_MIN_COUNT) continue;
        repo.rememberMemory({
            learnerId,
            kind: "struggle",
            text: `在「${nameOf(nodeId)}」上错过 ${count} 次，先补这个`,
            dedupeKey: `struggle:${nodeId}`,
            source: "derived",
        });
    }

    // 拿手：掌握度点亮
    for (const row of repo.allMastery(learnerId)) {
        if (row.p < 0.85 || row.evidenceN < 3) continue;
        repo.rememberMemory({
            learnerId,
            kind: "strength",
            text: `「${nameOf(row.nodeId)}」已经稳了，可以拿来当例子`,
            dedupeKey: `strength:${row.nodeId}`,
            source: "derived",
        });
    }
}

/** 召回给导师用的一小段文字（拼进 system prompt）。没有记忆就返回空串，不加噪声。 */
export function recallBlock(repo: Repo, learnerId: string, limit = 6): string {
    const memories = repo.listMemories(learnerId).slice(0, limit);
    if (memories.length === 0) return "";
    const lines = memories.map((m) => `- ${m.text}`);
    return `关于这个孩子，你记得这些（都是可以核查的事实，不确定就别当依据）：\n${lines.join("\n")}`;
}

/** 画像：兴趣/目标/是否更吃图形。全部来自家长或孩子手填，不猜。 */
export function readProfile(repo: Repo, learnerId: string): LearnerProfile {
    const prefs = repo.learnerPrefs(learnerId) as {
        interests?: unknown;
        goals?: unknown;
        prefersVisual?: unknown;
    };
    const asStrings = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
    return {
        interests: asStrings(prefs.interests),
        goals: asStrings(prefs.goals),
        prefersVisual: typeof prefs.prefersVisual === "boolean" ? prefs.prefersVisual : null,
    };
}

export function writeProfile(repo: Repo, learnerId: string, patch: Partial<LearnerProfile>): LearnerProfile {
    repo.setLearnerPrefs(learnerId, {
        ...(patch.interests ? { interests: patch.interests.map((s) => s.trim()).filter(Boolean).slice(0, 8) } : {}),
        ...(patch.goals ? { goals: patch.goals.map((s) => s.trim()).filter(Boolean).slice(0, 5) } : {}),
        ...(patch.prefersVisual === undefined ? {} : { prefersVisual: patch.prefersVisual }),
    });
    return readProfile(repo, learnerId);
}

/** 画像 → 导师上下文（和记忆分开写：一个是"事实"，一个是"孩子的设定"） */
export function profileBlock(profile: LearnerProfile): string {
    const parts: string[] = [];
    if (profile.interests.length > 0) parts.push(`他的兴趣：${profile.interests.join("、")}（出题可以拿这些当素材）`);
    if (profile.goals.length > 0) parts.push(`他最近想学会：${profile.goals.join("、")}`);
    if (profile.prefersVisual === true) parts.push("他更吃图形直观的解释，先画再算");
    if (profile.prefersVisual === false) parts.push("他更习惯从算式入手，图形只是辅助");
    return parts.length === 0 ? "" : `关于这个孩子的设定：\n${parts.join("\n")}`;
}
