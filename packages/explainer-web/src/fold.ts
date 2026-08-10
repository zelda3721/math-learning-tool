import type { SceneSpec } from "@mathtutor/schema";
import { collectRefs, num } from "./refs.js";

/**
 * 数量语汇折叠器：把 SceneSpec 折成「带身份的单位对象 + 拍间转场」。
 *
 * 宪法第 5 条（图形承担论证）在这里的落点是：**数量的变与不变必须可见**。
 * 因此本模块不再把 combine/partition_into/replicate/count/recount_verify
 * 一视同仁地降级成「高亮」，而是逐个实现动作语义：
 *   - 每一个「一」是有身份的 Unit（id 稳定、跨拍可追踪）；
 *   - 每一拍产出 moves（谁从哪来到哪去），播放器据此做连续动画；
 *   - 每一拍产出 counts（宣称的计数 vs 实际单位数），不一致必须暴露，
 *     绝不悄悄用宣称值覆盖实际值——那正是「验算」存在的意义；
 *   - 拿走的单位不会凭空消失，而是进入残影组（ghost），
 *     于是 conservation.before/after 能真正对上，守恒看得见。
 */

/** 一个单位（"一"）：有身份的对象，跨拍、跨组保持同一 id */
export interface Unit {
  /** 全局唯一且跨拍稳定：`${诞生组}#${诞生序号}`（复制体再加 `~份号`） */
  id: string;
  /** 当前所属组 */
  group: string;
  /** 在当前组内的位置（每拍快照时重排） */
  index: number;
  /** 诞生于哪个组：合并/迁移之后仍能看出"这些就是原来那些" */
  origin?: string;
  /** replicate 产生的复制体标记：第几份（0 起） */
  copy?: number;
  /** 一个 Unit 代表多少真实数量；仅在超过上限被聚合时 > 1 */
  weight?: number;
  /** swap_units（假设法）中被替换过：数量不变、类别变 */
  swapped?: boolean;
  /** 天平语义：这个单位在左盘还是右盘 */
  side?: "left" | "right";
  /** 天平语义：未知数方块 or 单位 */
  kind?: "unit" | "unknown";
}

/** 一拍里一个组的状态（数量型对象展开成单位；非数量型 units 为空数组） */
export interface GroupState {
  id: string;
  primitive: string;
  params: Record<string, unknown>;
  label?: string;
  meaning?: string;
  /** 展开后的单位；非数量型对象为 [] */
  units: Unit[];
  /** 本拍被动作触及 */
  emphasis?: boolean;
  /** 已移走但保留残影位（守恒可见）——播放器应画成灰/划掉且仍占位 */
  ghost?: boolean;
  /** 单位总量（= 各单位 weight 之和）；无单位时省略 */
  quantity?: number;
  /** 声明的数量（params.count/value/total），用于对照 */
  count?: number;
  /** 一个 Unit 代表 N 个真实单位（> 1 表示超上限后的聚合显示） */
  unitScale?: number;
  /** 由折叠过程派生出的组（残影区、等分份、余数组…），不在 visual_objects 中 */
  synthetic?: boolean;
  /** 派生自哪个组 */
  derivedFrom?: string;
  /** partition_into 除不尽时的余数组 */
  remainder?: boolean;
  /** 给播放器的一句人话标注（聚合比例、余数说明…） */
  note?: string;
}

/** 一拍的完整状态（渲染一拍 = 渲染一个 BeatState） */
export interface BeatState {
  index: number;
  role?: string;
  teachingLine?: string;
  groups: GroupState[];
  /**
   * 本拍发生的转场：谁从哪来到哪去，供播放器做连续动画。
   * replicate 拓出来的新单位也记一条，from = 被复制的源组（从源"拓印"出来）。
   */
  moves: { unitId: string; from: string; to: string }[];
  /** 本拍宣称的计数事实：播放器要把它画成"数一遍"，与实际单位数一致才算自洽 */
  counts: { groupId: string; claimed: number; actual: number }[];
  /** 守恒检查：总量应当不变的场合，出入是否平衡 */
  conservation?: { before: number; after: number; ok: boolean };
  /** 天平语义：两边的值与是否仍然相等（等式不变性可见） */
  equality?: { left: number; right: number; ok: boolean };
  /**
   * @deprecated 旧播放器的兼容视图（仅含 visual_objects 声明过的可见对象）。
   * 新播放器请消费 groups/moves/counts/conservation。
   */
  objects: RenderObject[];
}

/** @deprecated 旧的扁平渲染对象；保留仅为兼容尚未迁移的播放器代码 */
export interface RenderObject {
  id: string;
  primitive: string;
  params: Record<string, unknown>;
  label?: string;
  meaning?: string;
  count?: number;
  emphasis?: boolean;
  removedCount?: number;
}

/** 单位展开上限：超过则按「每单位代表 N」聚合，避免一屏几千个点 */
export const MAX_UNITS_PER_GROUP = 200;

/** 这些图元不是「数量」，即使 params 里有 total/value 也不展开成单位 */
const NON_QUANTITY_PRIMITIVES = new Set([
  "axes",
  "number_line",
  "function_curve",
  "balance",
  "relation_node",
]);

/** 真的会搬动单位、因而总量应当守恒的动作 */
const UNIT_MOVING_OPS = new Set([
  "take_from",
  "combine",
  "partition_into",
  "swap_units",
  "balance_remove",
  "balance_divide",
]);

/** 故意让总量变多的动作：这些拍不做守恒断言（守恒不成立才是对的） */
const GROWING_OPS = new Set(["replicate"]);

interface WorkUnit {
  id: string;
  group: string;
  origin: string;
  copy?: number;
  weight: number;
  swapped?: boolean;
  side?: "left" | "right";
  kind?: "unit" | "unknown";
}

interface WorkGroup {
  id: string;
  primitive: string;
  params: Record<string, unknown>;
  label?: string;
  meaning?: string;
  units: WorkUnit[];
  /**
   * 这个组是否属于「数量」范畴（展开过单位，或有单位进出过）。
   * 非数量组（axes / relation_node / 纯容器…）上的计数宣称无从核对，
   * 这时候既不能报"不一致"（假警报），也不能报"一致"（假背书）——只能不出 counts。
   */
  unitBearing: boolean;
  visible: boolean;
  emphasis: boolean;
  ghost: boolean;
  synthetic: boolean;
  declaredCount?: number;
  unitScale: number;
  /** 兼容旧播放器：累计被 take_from 拿走的数量 */
  removed: number;
  derivedFrom?: string;
  remainder?: boolean;
  note?: string;
  /** 折叠过程中变化的 params 覆盖（天平的 coefficient/constant/total） */
  overrides?: Record<string, unknown>;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

const strList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.length > 0);
  const one = str(v);
  return one !== undefined ? [one] : [];
};

/** 宽容取「整数数量」：非有限、非正、非整数一律视为不可展开 */
function integerQuantity(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const rounded = Math.round(v);
  if (Math.abs(v - rounded) > 1e-9) return undefined;
  if (rounded <= 0) return undefined;
  return rounded;
}

/** 第一个能读出整数数量的 key（count 优先，其次 value/total） */
function declaredQuantity(params: Record<string, unknown>): number | undefined {
  for (const key of ["count", "value", "total"]) {
    const q = integerQuantity(params[key]);
    if (q !== undefined) return q;
  }
  return undefined;
}

function quantityOf(group: WorkGroup): number {
  let sum = 0;
  for (const unit of group.units) sum += unit.weight;
  return sum;
}

/**
 * 把数量 n 展开成至多 MAX_UNITS_PER_GROUP 个单位。
 * 超上限时按「每单位代表 base 个」聚合，最后一个单位吃掉余数，
 * 保证 Σweight === n（聚合也不许把数量算错）。
 */
function expandUnits(
  groupId: string,
  n: number,
  extra: Partial<WorkUnit> = {},
  startIndex = 0,
): { units: WorkUnit[]; scale: number } {
  const base = n > MAX_UNITS_PER_GROUP ? Math.ceil(n / MAX_UNITS_PER_GROUP) : 1;
  const total = Math.ceil(n / base);
  const units: WorkUnit[] = [];
  for (let i = 0; i < total; i += 1) {
    const weight = i === total - 1 ? n - base * (total - 1) : base;
    units.push({
      id: `${groupId}#${startIndex + i}`,
      group: groupId,
      origin: groupId,
      weight,
      ...extra,
    });
  }
  return { units, scale: base };
}

/**
 * 把 scenes 顺序折叠成逐拍状态。
 *
 * 保留的既有规则：
 * - 整份 spec 没有任何 appear/reveal 时，所有对象第 0 拍即可见（引擎计划普遍不写 appear）；
 * - emphasis 每拍重置；removedCount 跨拍累计；
 * - 未知 op 忽略但不破坏可见性、不抛异常。
 */
export function foldBeats(spec: SceneSpec): BeatState[] {
  const declared = spec.visual_objects;
  const hasAppear = spec.scenes.some((beat) =>
    beat.actions.some((a) => a.op === "appear" || a.op === "reveal"),
  );

  const groups = new Map<string, WorkGroup>();
  const order: string[] = [];

  const addGroup = (group: WorkGroup) => {
    groups.set(group.id, group);
    order.push(group.id);
  };

  for (const obj of declared) {
    const params = (obj.params ?? {}) as Record<string, unknown>;
    const group: WorkGroup = {
      id: obj.id,
      primitive: obj.primitive,
      params,
      units: [],
      unitBearing: false,
      visible: !hasAppear,
      emphasis: false,
      ghost: false,
      synthetic: false,
      unitScale: 1,
      removed: 0,
    };
    if (obj.label !== undefined) group.label = obj.label;
    if (obj.meaning !== undefined) group.meaning = obj.meaning;

    if (obj.primitive === "balance") {
      expandBalance(group);
    } else if (!NON_QUANTITY_PRIMITIVES.has(obj.primitive)) {
      const n = declaredQuantity(params);
      if (n !== undefined) {
        group.declaredCount = n;
        const { units, scale } = expandUnits(obj.id, n);
        group.units = units;
        group.unitScale = scale;
        if (scale > 1) group.note = `每个单位代表 ${scale} 个`;
      }
    }
    group.unitBearing = group.units.length > 0;
    addGroup(group);
  }

  /** 需要一个折叠过程派生出来的组（残影区 / 等分份 / 余数组） */
  const ensureDerived = (
    id: string,
    init: { label?: string; ghost?: boolean; derivedFrom?: string; remainder?: boolean; note?: string },
  ): WorkGroup => {
    const existing = groups.get(id);
    if (existing) {
      existing.visible = true;
      if (init.ghost) existing.ghost = true;
      return existing;
    }
    const group: WorkGroup = {
      id,
      primitive: "unit_grid",
      params: {},
      units: [],
      unitBearing: true,
      visible: true,
      emphasis: false,
      ghost: init.ghost === true,
      synthetic: true,
      unitScale: 1,
      removed: 0,
    };
    if (init.label !== undefined) group.label = init.label;
    if (init.derivedFrom !== undefined) group.derivedFrom = init.derivedFrom;
    if (init.remainder === true) group.remainder = true;
    if (init.note !== undefined) group.note = init.note;
    addGroup(group);
    return group;
  };

  const beats: BeatState[] = [];
  let beatMoves: BeatState["moves"] = [];
  let beatCounts: BeatState["counts"] = [];

  const touch = (id: string | undefined): WorkGroup | undefined => {
    if (id === undefined) return undefined;
    const group = groups.get(id);
    if (group) group.emphasis = true;
    return group;
  };

  /** 搬运具体单位：身份不变，只换组；每一次都记进 moves */
  const moveUnits = (units: WorkUnit[], to: WorkGroup) => {
    for (const unit of units) {
      const from = groups.get(unit.group);
      if (from) {
        from.units = from.units.filter((u) => u !== unit);
        from.unitBearing = true;
      }
      const previous = unit.group;
      unit.group = to.id;
      to.units.push(unit);
      beatMoves.push({ unitId: unit.id, from: previous, to: to.id });
    }
    if (units.length > 0) to.unitBearing = true;
    to.visible = true;
    to.emphasis = true;
  };

  /** 从组的头部取出总量达到 quantity 的单位；不足就取完（由调用方决定怎么暴露） */
  const takeUnits = (from: WorkGroup, quantity: number): WorkUnit[] => {
    const picked: WorkUnit[] = [];
    let got = 0;
    for (const unit of from.units) {
      if (got >= quantity) break;
      picked.push(unit);
      got += unit.weight;
    }
    return picked;
  };

  const totalQuantity = (): number => {
    let sum = 0;
    for (const id of order) sum += quantityOf(groups.get(id)!);
    return sum;
  };

  const snapshot = (index: number, teachingLine?: string, role?: string): BeatState => {
    const visible = order.map((id) => groups.get(id)!).filter((g) => g.visible);

    const groupStates: GroupState[] = visible.map((group) => {
      const params =
        group.overrides !== undefined ? { ...group.params, ...group.overrides } : group.params;
      const state: GroupState = {
        id: group.id,
        primitive: group.primitive,
        params,
        units: group.units.map((unit, i) => {
          const out: Unit = { id: unit.id, group: group.id, index: i };
          if (unit.origin !== group.id) out.origin = unit.origin;
          if (unit.copy !== undefined) out.copy = unit.copy;
          if (unit.weight !== 1) out.weight = unit.weight;
          if (unit.swapped === true) out.swapped = true;
          if (unit.side !== undefined) out.side = unit.side;
          if (unit.kind !== undefined) out.kind = unit.kind;
          return out;
        }),
      };
      if (group.label !== undefined) state.label = group.label;
      if (group.meaning !== undefined) state.meaning = group.meaning;
      if (group.emphasis) state.emphasis = true;
      if (group.ghost) state.ghost = true;
      if (group.units.length > 0) state.quantity = quantityOf(group);
      if (group.declaredCount !== undefined) state.count = group.declaredCount;
      if (group.unitScale > 1) state.unitScale = group.unitScale;
      if (group.synthetic) state.synthetic = true;
      if (group.derivedFrom !== undefined) state.derivedFrom = group.derivedFrom;
      if (group.remainder === true) state.remainder = true;
      if (group.note !== undefined) state.note = group.note;
      return state;
    });

    // 兼容视图：只含声明过的对象，字段语义与旧 fold 完全一致
    const objects: RenderObject[] = visible
      .filter((group) => !group.synthetic)
      .map((group) => {
        const render: RenderObject = {
          id: group.id,
          primitive: group.primitive,
          params:
            group.overrides !== undefined ? { ...group.params, ...group.overrides } : group.params,
        };
        if (group.label !== undefined) render.label = group.label;
        if (group.meaning !== undefined) render.meaning = group.meaning;
        const count = num(group.params.count, Number.NaN);
        if (Number.isFinite(count)) render.count = count;
        if (group.emphasis) render.emphasis = true;
        if (group.removed > 0) render.removedCount = group.removed;
        return render;
      });

    const beat: BeatState = {
      index,
      ...(role !== undefined ? { role } : {}),
      ...(teachingLine !== undefined ? { teachingLine } : {}),
      groups: groupStates,
      moves: beatMoves,
      counts: beatCounts,
      objects,
    };
    return beat;
  };

  if (spec.scenes.length === 0) {
    if (declared.length === 0) return [];
    for (const group of groups.values()) group.visible = true;
    return [snapshot(0)];
  }

  spec.scenes.forEach((beat, index) => {
    for (const group of groups.values()) group.emphasis = false;
    beatMoves = [];
    beatCounts = [];

    const before = totalQuantity();
    let sawUnitMove = false;
    let sawGrowth = false;
    let sawBalanceOp = false;
    /** recount_verify 宣称的总量（优先于结构性守恒作为守恒断言） */
    let claimedTotal: number | undefined;
    let claimedTotalScope: string[] = [];

    for (const action of beat.actions) {
      const rec = action as Record<string, unknown>;
      const refs = collectRefs(action);
      if (UNIT_MOVING_OPS.has(action.op)) sawUnitMove = true;
      if (GROWING_OPS.has(action.op)) sawGrowth = true;

      switch (action.op) {
        case "appear":
        case "reveal":
        case "create": {
          for (const ref of refs) {
            const group = touch(ref);
            if (group) group.visible = true;
          }
          break;
        }

        case "take_from": {
          const source = touch(str(rec.source) ?? refs[0]);
          const claimed = Math.max(0, num(rec.count ?? rec.amount, 1));
          if (!source) break;
          source.visible = true;
          const destinationId = str(rec.destination) ?? str(rec.into) ?? str(rec.result);
          const destination =
            destinationId !== undefined
              ? (touch(destinationId) ??
                ensureDerived(destinationId, { label: "移入", derivedFrom: source.id }))
              : ensureDerived(`${source.id}__removed`, {
                  label: "移出区",
                  ghost: true,
                  derivedFrom: source.id,
                  note: "拿走的单位保留在这里，总量才对得上",
                });
          destination.visible = true;
          destination.emphasis = true;
          const picked = takeUnits(source, claimed);
          const moved = picked.reduce((sum, u) => sum + u.weight, 0);
          if (picked.length > 0) moveUnits(picked, destination);
          source.removed += moved;
          // 宣称拿走 claimed 个、实际只拿到 moved 个：必须暴露，不许静默夹带。
          // （聚合显示时可能整包超取，那是显示粒度不是数学错误，只报"不够拿"。）
          if (source.unitBearing && moved < claimed) {
            beatCounts.push({ groupId: destination.id, claimed, actual: moved });
          }
          break;
        }

        case "combine": {
          const explicit = strList(rec.sources);
          const destinationId =
            str(rec.destination) ?? str(rec.result) ?? str(rec.into) ?? str(rec.target);
          const candidates = explicit.length > 0 ? explicit : strList(rec.targets).concat(refs);
          const sourceIds = candidates.filter((id, i, arr) => arr.indexOf(id) === i);
          const destinationName =
            destinationId ?? sourceIds.find((id) => groups.has(id)) ?? sourceIds[0];
          if (destinationName === undefined) break;
          const destination =
            touch(destinationName) ??
            ensureDerived(destinationName, { label: "合并", derivedFrom: sourceIds[0] });
          destination.visible = true;
          for (const id of sourceIds) {
            if (id === destination.id) continue;
            const source = touch(id);
            if (!source) continue;
            source.visible = true;
            // 身份保留：搬过去的还是原来那些单位（origin 不变）
            moveUnits([...source.units], destination);
          }
          break;
        }

        case "partition_into": {
          const source = touch(str(rec.source) ?? str(rec.target) ?? refs[0]);
          const parts = Math.floor(num(rec.parts ?? rec.into_parts ?? rec.count ?? rec.groups, 0));
          if (!source || parts < 1) break;
          source.visible = true;
          // 按"看得见的单位个数"均分：等分与余数都是画面上数得出来的
          const n = source.units.length;
          const per = Math.floor(n / parts);
          const remainder = n - per * parts;
          for (let i = 0; i < parts; i += 1) {
            const part = ensureDerived(`${source.id}__part${i + 1}`, {
              label: `第 ${i + 1} 份`,
              derivedFrom: source.id,
            });
            if (per > 0) moveUnits(source.units.slice(0, per), part);
          }
          if (remainder > 0) {
            // 除不尽必须看得见：余数单独成组并标注
            const rest = ensureDerived(`${source.id}__remainder`, {
              label: "余数",
              derivedFrom: source.id,
              remainder: true,
            });
            rest.note = `${n} ÷ ${parts} = ${per} 余 ${remainder}`;
            moveUnits([...source.units], rest);
          }
          break;
        }

        case "replicate": {
          const source = touch(str(rec.source) ?? str(rec.target) ?? refs[0]);
          const times = Math.floor(num(rec.times ?? rec.count ?? rec.factor, 0));
          if (!source || times < 1) break;
          source.visible = true;
          const destinationId = str(rec.destination) ?? str(rec.result) ?? str(rec.into);
          const destination =
            destinationId !== undefined && destinationId !== source.id
              ? (touch(destinationId) ??
                ensureDerived(destinationId, { label: "复制结果", derivedFrom: source.id }))
              : source;
          destination.visible = true;
          destination.emphasis = true;
          // 模板永远是 source 当前的单位；就地复制时先固定模板再追加，
          // 保证「几个几」正好是 times × n，而不是滚雪球。
          const template = [...source.units];
          const inPlace = destination === source;
          const first = inPlace ? 1 : 0;
          for (let copy = first; copy < times; copy += 1) {
            for (const unit of template) {
              const clone: WorkUnit = {
                id: `${unit.id}~${copy}`,
                group: destination.id,
                // 新单位标记来源：这一份是从哪一组、哪一个单位拓出来的
                origin: unit.origin,
                copy,
                weight: unit.weight,
              };
              destination.units.push(clone);
              beatMoves.push({ unitId: clone.id, from: source.id, to: destination.id });
            }
          }
          break;
        }

        case "count":
        case "recount_verify": {
          const targets = (
            strList(rec.targets).length > 0 ? strList(rec.targets) : strList(rec.target).concat(refs)
          ).filter((id, i, arr) => arr.indexOf(id) === i);
          const claim = rec.expect ?? rec.expected ?? rec.value ?? rec.claimed ?? rec.count;
          const claimedValue = typeof claim === "number" && Number.isFinite(claim) ? claim : undefined;
          const expectTotal = rec.expect_total ?? rec.expected_total;
          const totalClaim =
            typeof expectTotal === "number" && Number.isFinite(expectTotal)
              ? expectTotal
              : targets.length > 1
                ? claimedValue
                : undefined;
          const countable: string[] = [];
          for (const id of targets) {
            const group = touch(id);
            if (!group) continue;
            group.visible = true;
            // 数不出单位的对象上不产生计数事实：假警报和假背书都是编造
            if (!group.unitBearing) continue;
            countable.push(id);
            const actual = quantityOf(group);
            const claimed =
              targets.length === 1 && claimedValue !== undefined ? claimedValue : actual;
            beatCounts.push({ groupId: id, claimed, actual });
          }
          if (totalClaim !== undefined && countable.length > 0) {
            claimedTotal = totalClaim;
            claimedTotalScope = countable;
          }
          break;
        }

        case "swap_units": {
          const a = str(rec.a);
          const b = str(rec.b);
          const count = Math.max(0, Math.floor(num(rec.count ?? rec.amount, 1)));
          const groupA = touch(a);
          const groupB = touch(b);
          if (groupA && groupB && groupA !== groupB) {
            // 两组对调同样多的单位：总量不变，构成变了
            const fromA = takeUnits(groupA, count);
            const fromB = takeUnits(groupB, count);
            moveUnits(fromA, groupB);
            moveUnits(fromB, groupA);
            break;
          }
          // 引擎的假设法形态：同一组里把 count 个单位换成另一类
          const source = touch(str(rec.source) ?? str(rec.target) ?? refs[0]);
          if (!source) break;
          source.visible = true;
          let swapped = 0;
          for (const unit of source.units) {
            if (swapped >= count) break;
            if (unit.swapped === true) continue;
            unit.swapped = true;
            swapped += 1;
          }
          if (source.unitBearing && swapped < count) {
            beatCounts.push({ groupId: source.id, claimed: count, actual: swapped });
          }
          break;
        }

        case "balance_remove":
        case "balance_divide": {
          sawBalanceOp = true;
          const targets = (
            strList(rec.targets).length > 0
              ? strList(rec.targets)
              : strList(rec.target).concat(refs)
          ).filter((id, i, arr) => arr.indexOf(id) === i);
          const count = Math.max(0, Math.floor(num(rec.count ?? rec.amount, 0)));
          for (const id of targets) {
            const group = touch(id);
            if (!group) continue;
            group.visible = true;
            const bin = ensureDerived(`${group.id}__removed`, {
              label: "两盘同时移出",
              ghost: true,
              derivedFrom: group.id,
              note: "两侧做同一件事，等式才不被破坏",
            });
            if (action.op === "balance_remove") balanceRemove(group, bin, count, moveUnits);
            else balanceDivide(group, bin, count, moveUnits);
          }
          break;
        }

        // 既有语义：只点亮，不改动数量
        case "move":
        case "highlight":
        case "transform":
        case "merge":
        case "partition":
        case "compare":
        case "map":
        case "measure":
        case "verify":
        case "balance_verify":
        case "remove": {
          for (const ref of refs) touch(ref);
          break;
        }

        default:
          // 未知 op：忽略，但既有可见性与状态一律不受影响
          break;
      }
    }

    if (beat.attention_target !== undefined) touch(beat.attention_target);

    const after = totalQuantity();
    const state = snapshot(index, beat.teaching_line, beat.role);

    if (claimedTotal !== undefined) {
      // 验算优先：宣称的总量 vs 这些组里真实数出来的总量
      let actual = 0;
      for (const id of claimedTotalScope) {
        const group = groups.get(id);
        if (group) actual += quantityOf(group);
      }
      state.conservation = {
        before: claimedTotal,
        after: actual,
        ok: Math.abs(claimedTotal - actual) < 1e-9,
      };
    } else if (sawUnitMove && !sawGrowth) {
      state.conservation = { before, after, ok: Math.abs(before - after) < 1e-9 };
    }

    if (sawBalanceOp) {
      const eq = balanceEquality(order.map((id) => groups.get(id)!));
      if (eq) state.equality = eq;
    }

    beats.push(state);
  });

  return beats;
}

/** 天平展开成两盘单位：左盘 = coefficient 个未知方块 + constant 个单位，右盘 = total 个单位 */
function expandBalance(group: WorkGroup): void {
  const params = group.params;
  const coefficient = integerQuantity(params.coefficient) ?? 0;
  const constant = Math.max(0, num(params.constant, 0));
  const total = Math.max(0, num(params.total, 0));
  const constantUnits = integerQuantity(constant) ?? 0;
  const totalUnits = integerQuantity(total) ?? 0;
  if (coefficient + constantUnits + totalUnits === 0) return;
  if (coefficient + constantUnits + totalUnits > MAX_UNITS_PER_GROUP) return;

  let cursor = 0;
  const push = (n: number, extra: Partial<WorkUnit>) => {
    const { units } = expandUnits(group.id, n, extra, cursor);
    cursor += units.length;
    group.units.push(...units);
  };
  if (coefficient > 0) push(coefficient, { side: "left", kind: "unknown" });
  if (constantUnits > 0) push(constantUnits, { side: "left", kind: "unit" });
  if (totalUnits > 0) push(totalUnits, { side: "right", kind: "unit" });
  group.overrides = { coefficient, constant: constantUnits, total: totalUnits };
}

function balanceState(group: WorkGroup): { coefficient: number; constant: number; total: number } {
  const live = group.overrides ?? group.params;
  return {
    coefficient: num(live.coefficient, num(group.params.coefficient, 0)),
    constant: num(live.constant, num(group.params.constant, 0)),
    total: num(live.total, num(group.params.total, 0)),
  };
}

type MoveFn = (units: WorkUnit[], to: WorkGroup) => void;

/** 两盘同时拿走 count 个单位：单位进残影组，总量守恒，等式不变 */
function balanceRemove(group: WorkGroup, bin: WorkGroup, count: number, move: MoveFn): void {
  if (count <= 0) return;
  const live = balanceState(group);
  const pick = (side: "left" | "right") =>
    group.units.filter((u) => u.side === side && u.kind === "unit").slice(0, count);
  // 两盘同时施加同一操作：左右各拿走 count 个，横梁才不会歪
  move([...pick("left"), ...pick("right")], bin);
  group.overrides = {
    ...live,
    constant: Math.max(0, live.constant - count),
    total: Math.max(0, live.total - count),
  };
}

/** 两盘同时分成 count 份、各留一份：其余进残影组，等式不变 */
function balanceDivide(group: WorkGroup, bin: WorkGroup, count: number, move: MoveFn): void {
  if (count <= 1) return;
  const live = balanceState(group);
  const drop: WorkUnit[] = [];
  for (const side of ["left", "right"] as const) {
    for (const kind of ["unknown", "unit"] as const) {
      const bucket = group.units.filter((u) => u.side === side && u.kind === kind);
      const keep = Math.floor(bucket.length / count);
      drop.push(...bucket.slice(keep));
    }
  }
  if (drop.length > 0) move(drop, bin);
  group.overrides = {
    ...live,
    coefficient: Math.floor(live.coefficient / count),
    constant: Math.floor(live.constant / count),
    total: Math.floor(live.total / count),
  };
}

/** 等式不变性：左盘 coefficient·solution + constant 是否仍等于右盘 total */
function balanceEquality(
  all: WorkGroup[],
): { left: number; right: number; ok: boolean } | undefined {
  for (const group of all) {
    if (group.primitive !== "balance" || !group.visible) continue;
    const solution = group.params.solution;
    if (typeof solution !== "number" || !Number.isFinite(solution)) continue;
    const live = balanceState(group);
    const left = live.coefficient * solution + live.constant;
    const right = live.total;
    return { left, right, ok: Math.abs(left - right) < 1e-9 };
  }
  return undefined;
}
