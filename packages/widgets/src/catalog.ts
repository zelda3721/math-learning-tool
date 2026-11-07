import type { WidgetSpec } from "./types.js";

/**
 * 首批十个数学组件（PLAN 阶段 3 的"首批 10 个数学组件"）。
 *
 * 挑选标准不是"好不好看"，而是**能不能只靠动手就看见一条关系**：
 * 分数条的等分、天平的平衡、数轴的跳跃、钟面的走格、面积格的铺满、十进制的捆与散、
 * 规律的延续、分类的归堆、坐标的点对、找零的加减。
 *
 * 每个组件都只写"能动的范围"，不写"正确答案"——判定留给收尾的那道题。
 */

const SPECS: WidgetSpec[] = [
  {
    kind: "number_line_jump",
    title: "数轴上的跳",
    prompt: "拖动起点，再选跳几格、往哪边跳，看看落点是怎么算出来的。",
    params: { min: -10, max: 20, tick: 1 },
    controls: [
      { key: "start", type: "step", label: "起点", min: -10, max: 20, step: 1 },
      { key: "jump", type: "step", label: "跳几格", min: 0, max: 10, step: 1 },
      { key: "direction", type: "pick", label: "方向", options: ["向右（加）", "向左（减）"] },
    ],
    insight: "往右跳是加、往左跳是减，落点 = 起点 ± 跳的格数。",
  },
  {
    kind: "fraction_bar",
    title: "分数条",
    prompt: "改一改分母和分子，看这条被分成几份、涂了几份。",
    params: { maxDenominator: 12 },
    controls: [
      { key: "denominator", type: "step", label: "分成几份", min: 2, max: 12, step: 1 },
      { key: "numerator", type: "step", label: "涂几份", min: 0, max: 12, step: 1 },
    ],
    insight: "分母说分成几份，分子说取了其中几份；涂满所有份正好是 1。",
  },
  {
    kind: "balance_scale",
    title: "天平",
    prompt: "往两边放砝码，看看天平什么时候才平。",
    params: { maxWeight: 20 },
    controls: [
      { key: "left", type: "step", label: "左边", min: 0, max: 20, step: 1 },
      { key: "right", type: "step", label: "右边", min: 0, max: 20, step: 1 },
    ],
    insight: "只有两边一样重，天平才平；差多少就歪多少。",
  },
  {
    kind: "clock_face",
    title: "钟面",
    prompt: "拨时针和分针，看看一整天是怎么走过去的。",
    params: { minutesPerTurn: 60 },
    controls: [
      { key: "hour", type: "step", label: "几点", min: 0, max: 23, step: 1 },
      { key: "minute", type: "step", label: "几分", min: 0, max: 59, step: 5 },
    ],
    insight: "分针走一圈是 60 分钟，也就是时针走一大格。",
  },
  {
    kind: "area_grid",
    title: "铺满它",
    prompt: "改长和宽，看要用多少个小方格才能铺满。",
    params: { maxSide: 10 },
    controls: [
      { key: "width", type: "step", label: "长", min: 1, max: 10, step: 1 },
      { key: "height", type: "step", label: "宽", min: 1, max: 10, step: 1 },
    ],
    insight: "每行放几个 × 有几行 = 一共几个格子，这就是面积。",
  },
  {
    kind: "base10_blocks",
    title: "十进制的捆和散",
    prompt: "加几个一、几个十，看它什么时候要捆成一条。",
    params: { maxOnes: 30, maxTens: 9 },
    controls: [
      { key: "ones", type: "step", label: "散的（个）", min: 0, max: 30, step: 1 },
      { key: "tens", type: "step", label: "成条的（十）", min: 0, max: 9, step: 1 },
    ],
    insight: "满十个一就捆成一条十：10 个一 = 1 个十。",
  },
  {
    kind: "pattern_train",
    title: "规律火车",
    prompt: "选一组颜色，看后面几节车厢该接什么。",
    params: { length: 8 },
    controls: [
      { key: "mode", type: "toggle", label: "两种颜色交替" },
    ],
    insight: "规律就是「下一节由前面几节决定」，看清一组里有几节就接得住。",
  },
  {
    kind: "sorting_bins",
    title: "分堆",
    prompt: "把东西拖进不同的筐，看看每筐归的都是同一类。",
    params: { bins: 3 },
    controls: [
      { key: "bin", type: "pick", label: "放进哪个筐", options: ["筐 A", "筐 B", "筐 C"] },
      { key: "count", type: "step", label: "放几个", min: 0, max: 20, step: 1 },
    ],
    insight: "分类的规矩要说得出来：为什么这两个在同一个筐里。",
  },
  {
    kind: "coordinate_plot",
    title: "格子上的点",
    prompt: "改横坐标和纵坐标，看这个点在格子的哪个位置。",
    params: { maxX: 12, maxY: 12 },
    controls: [
      { key: "x", type: "step", label: "往右走几格", min: 0, max: 12, step: 1 },
      { key: "y", type: "step", label: "往上走几格", min: 0, max: 12, step: 1 },
    ],
    insight: "先说往右几格、再说往上几格：(3, 2) 和 (2, 3) 是两个地方。",
  },
  {
    kind: "money_change",
    title: "找零",
    prompt: "改价格和你付的钱，看看该找回多少。",
    params: { currency: "元", maxPrice: 50 },
    controls: [
      { key: "price", type: "step", label: "价格", min: 1, max: 50, step: 1 },
      { key: "paid", type: "step", label: "付了", min: 1, max: 100, step: 1 },
    ],
    insight: "找零 = 付的钱 − 价格；付得不够就没得找。",
  },
];

/** 组件的全部清单：顺序固定（先数、再形、再量、再钱），孩子按顺序摸最稳 */
export function allWidgets(): WidgetSpec[] {
  return SPECS.map((s) => ({ ...s }));
}

export function widgetOf(kind: string): WidgetSpec | null {
  return SPECS.find((s) => s.kind === kind) ?? null;
}

/**
 * 按知识点挑一个组件。
 *
 * 关键词优先、学科兜底：图谱里的节点没有"该配哪个组件"这种字段，
 * 与其给 75 个节点各标一遍，不如按名字和关键词认——认得出来就配，
 * 认不出来就**不配**（给一个不相干的组件，比不给更让人困惑）。
 */
export function widgetForNode(node: { id?: string; name?: string; keywords?: string[]; strand?: string }): WidgetSpec | null {
  const hay = [node.name ?? "", ...(node.keywords ?? [])].join(" ");
  const rules: { kind: string; test: RegExp }[] = [
    { kind: "number_line_jump", test: /数轴|加减|进位|退位|整数运算/ },
    { kind: "fraction_bar", test: /分数|几分之|通分|约分/ },
    { kind: "balance_scale", test: /方程|等式|天平|平衡/ },
    { kind: "clock_face", test: /时间|钟|时|分/ },
    { kind: "area_grid", test: /面积|周长|长方|正方/ },
    { kind: "base10_blocks", test: /十进|位值|个位|十位|数位/ },
    { kind: "pattern_train", test: /规律|周期|找规律/ },
    { kind: "sorting_bins", test: /分类|统计|集合/ },
    { kind: "coordinate_plot", test: /坐标|位置|方向|图形/ },
    { kind: "money_change", test: /钱|元角分|价格|找零|购物/ },
  ];
  for (const rule of rules) {
    if (rule.test.test(hay)) return widgetOf(rule.kind);
  }
  void node.id;
  void node.strand;
  return null;
}
