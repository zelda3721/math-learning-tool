import { describe, expect, it } from "vitest";
import { RegistryError, SubjectRegistry, type SubjectPackage } from "../src/index.js";

function pkg(over: Partial<SubjectPackage> = {}): SubjectPackage {
  return {
    id: "demo",
    name: "示例学科",
    itemTypes: [{ id: "demo.text", subject: "demo", name: "填空", answerMode: "text" }],
    judges: [
      {
        id: "demo.text.judge",
        subject: "demo",
        itemTypes: ["demo.text"],
        judge: () => ({ correct: true, method: "exact", verification: "reference" }),
      },
    ],
    ...over,
  };
}

describe("学科注册表", () => {
  it("登记后能按学科与题型取到判卷器", () => {
    const r = new SubjectRegistry();
    r.register(pkg());
    expect(r.judgeFor("demo", "demo.text")?.id).toBe("demo.text.judge");
  });

  it("学科只有一个判卷器时，只给学科就能解析", () => {
    const r = new SubjectRegistry();
    r.register(pkg());
    expect(r.judgeFor("demo")?.id).toBe("demo.text.judge");
  });

  it("一个学科有多个判卷器时，只给学科返回 undefined——不许随便挑一个", () => {
    const r = new SubjectRegistry();
    r.register(
      pkg({
        judges: [
          { id: "a", subject: "demo", itemTypes: ["demo.text"], judge: () => ({ correct: true, method: "a", verification: "reference" }) },
          { id: "b", subject: "demo", itemTypes: ["demo.other"], judge: () => ({ correct: true, method: "b", verification: "ai_unverified" }) },
        ],
      }),
    );
    expect(r.judgeFor("demo")).toBeUndefined();
    expect(r.judgeFor("demo", "demo.other")?.id).toBe("b");
  });

  it("学科不存在时安静返回 undefined（调用方据此走 pending，而不是崩）", () => {
    const r = new SubjectRegistry();
    expect(r.judgeFor("nope")).toBeUndefined();
    expect(r.judgeFor("nope", "nope.any")).toBeUndefined();
  });

  it("学科 id 重复 → 抛错（覆盖语义会让人以为改动生效了，其实生效的是别处那份）", () => {
    const r = new SubjectRegistry();
    r.register(pkg());
    expect(() => r.register(pkg())).toThrow(RegistryError);
  });

  it("判卷器 id 全局唯一", () => {
    const r = new SubjectRegistry();
    r.register(pkg());
    expect(() =>
      r.register(pkg({ id: "demo2", itemTypes: [], judges: [{ id: "demo.text.judge", subject: "demo2", itemTypes: [], judge: () => ({ correct: true, method: "x", verification: "reference" }) }] })),
    ).toThrow(RegistryError);
  });

  it("判卷器不能注册到别人的学科下", () => {
    const r = new SubjectRegistry();
    const wrong = pkg({
      id: "math",
      judges: [{ id: "x", subject: "english", itemTypes: [], judge: () => ({ correct: true, method: "x", verification: "reference" }) }],
    });
    expect(() => r.register(wrong)).toThrow(RegistryError);
  });

  it("题型可以挂多个判卷器，按登记顺序取第一个（有意为之的优先级）", () => {
    const r = new SubjectRegistry();
    r.register(
      pkg({
        judges: [
          { id: "first", subject: "demo", itemTypes: ["demo.text"], judge: () => ({ correct: true, method: "1", verification: "reference" }) },
          { id: "second", subject: "demo", itemTypes: ["demo.text"], judge: () => ({ correct: true, method: "2", verification: "reference" }) },
        ],
      }),
    );
    expect(r.judgeForItemType("demo.text")?.id).toBe("first");
  });
});
