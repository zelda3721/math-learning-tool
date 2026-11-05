/**
 * 视觉词汇表：图元 → 它该怎么被布局与绘制。
 *
 * 为什么要有这一层：图元的分类原先散在两个模块的三张集合里（fold 的"是不是可数量"、
 * fold 的"是不是条"、scene 的"是不是画在坐标系里"）。加一门学科的新图元
 * （`phys.force_arrow`、`en.vocab_card`）就得改这三处，而分类是数据，不该是分支。
 *
 * 三个标记回答的是**三个不同的问题**，刻意不合并成一个枚举：
 * - `plotted`：画在坐标系里吗（scene 决定走坐标分支还是流式分支）
 * - `quantity`：会展开成可数记号吗（fold 决定要不要按数量处理）
 * - `magnitude`：是"长度正比于数值"的条吗
 *
 * 合并不了是有证据的：`polygon` 画在坐标系里，同时也按数量处理；
 * 一个枚举说不出这件事，硬塞会悄悄改掉现有行为。
 *
 * 学科包的图元照约定带学科前缀（`phys.`、`en.`）。**现有数学图元一个都不改名**——
 * 它们已经在真实讲解里跑着了，改名等于让所有历史 SceneSpec 一夜失效。
 */

export interface VisualDefinition {
  primitive: string;
  /** 学科归属；现有数学图元留空 = math */
  subject?: string;
  /** 画在坐标系里（坐标由数学决定，不是布局排出来的） */
  plotted?: boolean;
  /** 会展开成可数记号（fold 把它当"数量对象"） */
  quantity?: boolean;
  /** 量：长度正比于数值的条。给 count 时仍然可数，这一条由 fold 读参数后定 */
  magnitude?: boolean;
  /** 讲义原图的转写重画 */
  figure?: boolean;
}

/**
 * 内置词表 = 数学现有的图元。
 *
 * 三个标记的取值与改造前的三张集合**逐项对齐**，不借这次重构顺手改行为：
 * 分类搬家，语义不动。
 */
export const BUILTIN_VISUALS: VisualDefinition[] = [
  { primitive: "dot", plotted: true, quantity: true },
  { primitive: "circle", quantity: true },
  { primitive: "rectangle", quantity: true },
  { primitive: "line", plotted: true, quantity: true },
  { primitive: "arrow", plotted: true, quantity: true },
  { primitive: "polygon", plotted: true, quantity: true },
  { primitive: "function_curve", plotted: true },
  { primitive: "number_line", plotted: true },
  { primitive: "axes", plotted: true },
  { primitive: "quantity_bar", quantity: true, magnitude: true },
  { primitive: "unit_grid", quantity: true },
  { primitive: "relation_node" },
  { primitive: "balance" },
  { primitive: "figure", figure: true },
  // 微积分图元（引擎产出，坐标由已算好的数据给出）
  { primitive: "tangent_line", plotted: true },
  { primitive: "secant_line", plotted: true },
  { primitive: "riemann_rects", plotted: true },
  { primitive: "limit_approach", plotted: true },
  { primitive: "composition_chain", plotted: true },
];

export class VisualRegistry {
  private readonly byPrimitive = new Map<string, VisualDefinition>();

  constructor(definitions: VisualDefinition[] = BUILTIN_VISUALS) {
    for (const def of definitions) this.register(def);
  }

  register(def: VisualDefinition): void {
    // 同名图元来自两个学科是配置错误，不是覆盖语义：覆盖会让人以为改动生效了，
    // 实际生效的是别处那一份——和学科注册表里判卷器 id 重复同一个道理。
    if (this.byPrimitive.has(def.primitive)) {
      throw new Error(`图元重复声明: ${def.primitive}`);
    }
    this.byPrimitive.set(def.primitive, def);
  }

  get(primitive: string): VisualDefinition | undefined {
    return this.byPrimitive.get(primitive);
  }

  has(primitive: string): boolean {
    return this.byPrimitive.has(primitive);
  }

  isPlotted(primitive: string): boolean {
    return this.byPrimitive.get(primitive)?.plotted === true;
  }

  isQuantity(primitive: string): boolean {
    return this.byPrimitive.get(primitive)?.quantity === true;
  }

  isMagnitude(primitive: string): boolean {
    return this.byPrimitive.get(primitive)?.magnitude === true;
  }

  isFigure(primitive: string): boolean {
    return this.byPrimitive.get(primitive)?.figure === true;
  }

  list(): VisualDefinition[] {
    return [...this.byPrimitive.values()];
  }

  /**
   * 派生一个新表（内置 + 学科新增）。
   *
   * 已存在的图元**不覆盖**：一门学科声明的 `dot` 不该悄悄替换掉所有人的点。
   * 要不同的表现，就该起一个带前缀的新名字。
   */
  extend(extra: VisualDefinition[]): VisualRegistry {
    const merged = [...this.list()];
    for (const def of extra) {
      if (merged.some((d) => d.primitive === def.primitive)) continue;
      merged.push(def);
    }
    return new VisualRegistry(merged);
  }
}

/** 进程内默认词表（内置数学图元）。要扩展就用 extend 派生，不要在这里 mutate */
export const defaultVisuals = new VisualRegistry();
