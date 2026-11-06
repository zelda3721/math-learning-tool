import type { BeatState } from "./fold.js";

/** 会"搬动单位"的动作：它们一旦没有产生搬运，就说明过程没画出来 */
const QUANTITY_VERBS = new Set([
  "take_from",
  "combine",
  "partition_into",
  "partition",
  "replicate",
  "swap_units",
  "merge",
]);

/** 会"清点"的动作：目标是空的话，数它等于没数 */
const COUNTING_VERBS = new Set(["count", "recount_verify"]);

export interface ActionLike {
  op?: string;
  source?: unknown;
  target?: unknown;
  targets?: unknown;
  destination?: unknown;
}

const refsOf = (action: ActionLike): string[] => {
  const out: string[] = [];
  for (const value of [action.target, action.source]) {
    if (typeof value === "string") out.push(value);
  }
  for (const value of [action.targets]) {
    if (Array.isArray(value)) out.push(...value.filter((v): v is string => typeof v === "string"));
  }
  return out;
};

/**
 * 语义门禁：`VISUAL_SEMANTICS_DESIGN.md` §1 那三个反例的可执行版本。
 *
 * 那节记录的是一次"12/12 全过、但减法从未被展示"的事故。事后归因不是某一层的 bug，
 * 而是**动作语义在每一层都不被强制**：计划能写出不可执行的动作，模板能把动作降级成装饰，
 * 审查不必对照自己的观察打分。所以门禁不能只看"格式对不对"，得看**画面有没有真的动**。
 *
 * 三条都在 BeatState 上判——它是两条编译路径的共同产物，判定因此与生成方式无关：
 * LLM 导演写的和确定性构造器画的，用同一把尺。
 */

export type SemanticCode =
  /** 宣称的数量和画面上真实的个数对不上（§1：heads 标着 35，画面上 0 个） */
  | "claim-mismatch"
  /** 这一拍宣称有过程（换、数、分），但各组构成与数量跟上一拍一模一样 */
  | "process-not-shown"
  /** 清点/验证的目标是空容器：验证两个空框，什么都没验证 */
  | "empty-target";

export interface SemanticFinding {
  code: SemanticCode;
  beat: number;
  detail: string;
}

const groupTotals = (beat: BeatState): Map<string, number> => {
  const out = new Map<string, number>();
  for (const g of beat.groups) {
    const units = g.units.reduce((sum, u) => sum + (u.weight ?? 1), 0);
    out.set(g.id, units + (g.magnitude ?? 0));
  }
  return out;
};

const sameTotals = (a: Map<string, number>, b: Map<string, number>): boolean => {
  if (a.size !== b.size) return false;
  for (const [id, value] of a) {
    if (b.get(id) !== value) return false;
  }
  return true;
};

/**
 * 判定整段讲解。返回空数组表示通过。
 *
 * 刻意只报**能被证实**的问题：
 * - 宣称值 vs 实际个数是硬事实，直接对；
 * - "有没有变化"用各组构成与数量对比上一拍，不猜语义；
 * - 空目标看的是这一组到底有没有东西可数。
 *
 * 不做的事：不判断"画得好不好"、不判断教学句写得对不对。那些需要模型或人来看，
 * 而门禁一旦开始猜语义，就会出现"为了过闸门而改措辞"的退化。
 */
export function gateBeats(
  beats: BeatState[],
  /**
   * 原始 spec。**必须有**：光看 BeatState 抓不到两类问题——
   * fold 会把空目标上的计数事实直接丢掉（"数不出单位的对象不产生计数"),
   * 而"动作没产生搬运"恰恰要拿动作本身来对照。
   */
  spec?: { scenes?: { actions?: ActionLike[] }[] },
): SemanticFinding[] {
  const findings: SemanticFinding[] = [];

  beats.forEach((beat, index) => {
    // ① 宣称多少就得有多少
    for (const claim of beat.counts) {
      if (claim.claimed === claim.actual) continue;
      findings.push({
        code: "claim-mismatch",
        beat: beat.index,
        detail: `「${claim.groupId}」标着 ${claim.claimed}，画面上只有 ${claim.actual} 个`,
      });
    }

    // ② 宣称有过程，但画面没动
    //
    // 判据刻意收紧：只有"这一拍声明了过程（换了/数了）"、"没有任何搬运"、
    // 且各组构成与数量与上一拍完全一致时才报。合法的停顿（讲解 hold）不会声明过程，
    // 因此不会被误伤。
    const actions = spec?.scenes?.[index]?.actions ?? [];
    const verbs = actions
      .map((a) => a.op ?? "")
      .filter((op) => QUANTITY_VERBS.has(op));
    const previous = index > 0 ? beats[index - 1] : undefined;
    if (verbs.length > 0 && previous && beat.moves.length === 0) {
      if (sameTotals(groupTotals(previous), groupTotals(beat))) {
        findings.push({
          code: "process-not-shown",
          beat: beat.index,
          detail: `这一拍写了 ${verbs.join("/")}，但没有任何单位被搬动、各组数量与上一拍一样：过程没有画出来`,
        });
      }
    }

    // ③ 清点空目标：fold 不会为空目标产生计数事实，所以要看动作本身
    for (const action of actions) {
      if (!COUNTING_VERBS.has(action.op ?? "")) continue;
      for (const id of refsOf(action)) {
        const group = beat.groups.find((g) => g.id === id);
        if (!group) continue;
        if (group.units.length === 0 && group.magnitude === undefined) {
          findings.push({
            code: "empty-target",
            beat: beat.index,
            detail: `「${id}」是空的（没有单位也没有量）：验证它等于什么都没验证`,
          });
        }
      }
    }
  });

  return findings;
}
