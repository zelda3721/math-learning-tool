import { describe, expect, it } from "vitest";
import {
  allWidgets,
  applyWidgetAction,
  initialWidgetState,
  replayWidget,
  summarizeWidget,
  validateWidgetHtml,
  widgetCsp,
  widgetForNode,
  widgetOf,
  widgetSandboxAttr,
} from "../src/index.js";

/**
 * 交互组件：十个组件的行为必须能被机器检查，沙箱必须真的挡住东西。
 *
 * 这两件事都不该靠"点一遍看看"来验收：组件的边界（涂满、跳过头）和沙箱的
 * 每一条禁令，都是能在 node 里跑出来的。
 */

describe("十个组件都立得住", () => {
  it("清单正好十个，kind 不重复，每个都有玩法与一句提示", () => {
    const widgets = allWidgets();
    expect(widgets).toHaveLength(10);
    expect(new Set(widgets.map((w) => w.kind)).size).toBe(10);
    for (const w of widgets) {
      expect(w.title.length).toBeGreaterThan(0);
      expect(w.prompt.length).toBeGreaterThan(0);
      expect(w.insight.length).toBeGreaterThan(0);
      expect(w.controls.length).toBeGreaterThan(0);
    }
  });

  it("每个组件都能初始化、都能说出一句人话", () => {
    for (const w of allWidgets()) {
      const state = initialWidgetState(w);
      expect(Object.keys(state).length).toBeGreaterThan(0);
      const text = summarizeWidget(w, state);
      expect(text.length).toBeGreaterThan(0);
    }
  });
});

describe("边界要夹住，并且说出来", () => {
  it("分数条：涂的份数不会超过分母", () => {
    const spec = widgetOf("fraction_bar")!;
    const state = { denominator: 4, numerator: 1 };
    const result = applyWidgetAction(spec, state, { op: "set", key: "numerator", value: 9 });
    expect(result.state.numerator).toBe(4);
    expect(result.note).toContain("4");
  });

  it("控件范围之外的数字被夹回上界", () => {
    const spec = widgetOf("area_grid")!;
    const result = applyWidgetAction(spec, initialWidgetState(spec), { op: "set", key: "width", value: 99 });
    expect(result.state.width).toBe(10);
    expect(result.note).toBeTruthy();
  });

  it("不存在的控件不会被悄悄创建", () => {
    const spec = widgetOf("clock_face")!;
    const result = applyWidgetAction(spec, initialWidgetState(spec), { op: "set", key: "秒", value: 3 });
    expect(result.state).toEqual(initialWidgetState(spec));
    expect(result.note).toContain("秒");
  });

  it("选择题只认给出来的选项", () => {
    const spec = widgetOf("number_line_jump")!;
    const bad = applyWidgetAction(spec, initialWidgetState(spec), { op: "pick", key: "direction", value: "向上" });
    expect(bad.state.direction).toBe("向右（加）");
    expect(bad.note).toBeTruthy();
    const good = applyWidgetAction(spec, initialWidgetState(spec), { op: "pick", key: "direction", value: "向左（减）" });
    expect(good.state.direction).toBe("向左（减）");
  });

  it("重放同一串操作得到同一个状态（回看与调试靠它）", () => {
    const actions = [
      { op: "set" as const, key: "start", value: 5 },
      { op: "add" as const, key: "jump", delta: 2 },
      { op: "pick" as const, key: "direction", value: "向左（减）" },
    ];
    const a = replayWidget("number_line_jump", actions);
    const b = replayWidget("number_line_jump", actions);
    expect(a).toEqual(b);
    expect(a).toEqual({ start: 5, jump: 6, direction: "向左（减）" });
  });

  it("每句话都说对了数：找零、面积、十进制", () => {
    expect(summarizeWidget(widgetOf("money_change")!, { price: 8, paid: 10 })).toContain("应找 2");
    expect(summarizeWidget(widgetOf("money_change")!, { price: 8, paid: 5 })).toContain("不够");
    expect(summarizeWidget(widgetOf("area_grid")!, { width: 4, height: 3 })).toContain("12");
    expect(summarizeWidget(widgetOf("base10_blocks")!, { ones: 6, tens: 1 })).toContain("16");
    expect(summarizeWidget(widgetOf("balance_scale")!, { left: 5, right: 5 })).toContain("平");
  });
});

describe("按知识点配组件", () => {
  it("认得出常见知识点", () => {
    expect(widgetForNode({ name: "分数的初步认识" })?.kind).toBe("fraction_bar");
    expect(widgetForNode({ name: "长方形面积" })?.kind).toBe("area_grid");
    expect(widgetForNode({ name: "认识时间" })?.kind).toBe("clock_face");
  });

  it("认不出来就不配（给一个不相干的组件比不给更糟）", () => {
    expect(widgetForNode({ name: "复数的三角形式" })).toBeNull();
  });
});

describe("自由 HTML 的沙箱", () => {
  const good = `<canvas id="c"></canvas><script>const el=document.getElementById('c');el.textContent='1/2';</script>`;

  it("普通内联组件能过", () => {
    expect(validateWidgetHtml(good)).toEqual({ ok: true, errors: [] });
  });

  it("联网、外链、跳出沙箱、动态执行，逐条挡住", () => {
    const bad = [
      `<script src="https://cdn.example.com/a.js"></script>`,
      `<script>fetch('https://x.com')</script>`,
      `<script>new XMLHttpRequest()</script>`,
      `<script>eval('1+1')</script>`,
      `<script>new Function('return 1')</script>`,
      `<script>document.cookie</script>`,
      `<script>localStorage.setItem('a','b')</script>`,
      `<script>window.top.location='x'</script>`,
      `<a href="javascript:alert(1)">x</a>`,
      `<iframe src="https://x.com"></iframe>`,
      `<form action="https://x.com"><input></form>`,
      `<img src="https://x.com/a.png">`,
    ];
    for (const html of bad) {
      const result = validateWidgetHtml(html);
      expect(result.ok, html).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("超大 HTML 直接拒（不给孩子下载一个巨型页面）", () => {
    const huge = `<div>${"x".repeat(200_001)}</div>`;
    expect(validateWidgetHtml(huge).ok).toBe(false);
  });

  it("CSP 与 sandbox 两把锁都在，且都够紧", () => {
    const csp = widgetCsp();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    // 不给 same-origin：脚本就碰不到本站的 cookie 与 DOM
    expect(widgetSandboxAttr()).not.toContain("allow-same-origin");
    expect(widgetSandboxAttr()).toContain("allow-scripts");
  });
});
