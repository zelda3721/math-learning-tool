import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Question } from "@mathtutor/schema";

import { grade, parseNumeric, expressionsEquivalent, splitAnswerParts, deriveAnswerType, equationSatisfiesCondition } from "../src/grading.js";

describe("parseNumeric", () => {
  it("handles integers, decimals, fractions, percents, units, fullwidth", () => {
    expect(parseNumeric("26")).toBe(26);
    expect(parseNumeric("26 厘米")).toBe(26);
    expect(parseNumeric("３.５")).toBe(3.5);
    expect(parseNumeric("3/4")).toBe(0.75);
    expect(parseNumeric("75%")).toBe(0.75);
    expect(parseNumeric("-12")).toBe(-12);
    expect(parseNumeric("没有数字")).toBeNull();
    expect(parseNumeric("1/0")).toBeNull();
  });
});

describe("grade numeric", () => {
  const q = { answer: "26", answerType: "numeric" as const };
  it("accepts equivalent numeric forms", () => {
    expect(grade(q, "26").correct).toBe(true);
    expect(grade(q, "26厘米").correct).toBe(true);
    expect(grade(q, "26.0").correct).toBe(true);
  });
  it("rejects wrong values and empty", () => {
    expect(grade(q, "24").correct).toBe(false);
    expect(grade(q, "").correct).toBe(false);
  });
  it("fraction answer accepts decimal form", () => {
    const fq = { answer: "3/4", answerType: "numeric" as const };
    expect(grade(fq, "0.75").correct).toBe(true);
    expect(grade(fq, "6/8").correct).toBe(true);
  });
});

describe("grade expression", () => {
  it("accepts algebraically equivalent forms", () => {
    expect(expressionsEquivalent("2x+3", "3+2x")).toBe(true);
    expect(expressionsEquivalent("(x+1)^2", "x^2+2x+1")).toBe(true);
    expect(expressionsEquivalent("2x+3", "2x+4")).toBe(false);
  });
  it("equation answer x=4 accepts bare 4", () => {
    const q = { answer: "x=4", answerType: "expression" as const };
    expect(grade(q, "4").correct).toBe(true);
    expect(grade(q, "x=4").correct).toBe(true);
    expect(grade(q, "5").correct).toBe(false);
  });
  it("is deterministic across runs", () => {
    for (let i = 0; i < 5; i++) expect(expressionsEquivalent("x*2", "2x")).toBe(true);
  });
});

describe("grade steps", () => {
  it("marks subjective answers pending (parent review queue)", () => {
    const q = { answer: "先算周长公式", answerType: "steps" as const };
    const r = grade(q, "我先把长和宽加起来再乘二");
    expect(r.method).toBe("pending");
    expect(r.correct).toBe(false);
  });
});

/**
 * 用真实题库里的参考答案做样本（120 道题原样读自讲义，没有结构化）。
 *
 * 三条纪律：形式不同不算错；只答一半不算对；判不准就别判（转 pending）。
 */
describe("形式不同不算错", () => {
  const ok = (ref: string, stu: string, type: "numeric" | "expression" | "steps" = "numeric") =>
    grade({ answer: ref, answerType: type }, stu).correct;

  it.each([
    ["带单位", "26", "26厘米"],
    ["带空格", "26", " 26 "],
    ["全角数字", "26", "２６"],
    ["分数与小数", "0.5", "1/2"],
    ["带分数", "2.5", "2又1/2"],
    ["中文数字", "10", "十"],
    ["中文数字带单位", "15", "十五只"],
    ["百分数", "0.25", "25%"],
    ["角度符号", "150°", "150度"],
  ])("%s：参考「%s」孩子写「%s」", (_why, ref, stu) => {
    expect(ok(ref, stu)).toBe(true);
  });

  it("代数式的等价变形", () => {
    expect(ok("2x+2", "2(x+1)", "expression")).toBe(true);
    expect(ok("x=4", "4", "expression")).toBe(true);
  });

  it("集合型答案与顺序无关", () => {
    expect(ok("乙和丁", "丁和乙")).toBe(true);
  });

  it("多值答案：孩子省掉序号也算对", () => {
    // 参考答案带序号（1亚洲、2大洋洲…），孩子多半只写洲名
    const r = grade(
      { answer: "1亚洲、2大洋洲、3欧洲、4非洲、5美洲", answerType: "numeric" },
      "亚洲、大洋洲、欧洲、非洲、美洲",
    );
    // 段数对得上，逐段判不准 → 交给家长，而不是判错
    expect(r.correct).toBe(false);
    expect(r.method).toBe("pending");
  });
});

describe("只答一半不算对", () => {
  it("参考「44，20」孩子只写「44」→ 判错（此前判对）", () => {
    expect(grade({ answer: "44，20", answerType: "steps" }, "44").correct).toBe(false);
  });

  it("两个数都写对才算对", () => {
    expect(grade({ answer: "44，20", answerType: "steps" }, "44，20").correct).toBe(true);
    expect(grade({ answer: "44，20", answerType: "steps" }, "甲堆44个，乙堆20个").correct).toBe(true);
    expect(grade({ answer: "16，256", answerType: "steps" }, "16和256").correct).toBe(true);
  });

  it("顺序反了不算对", () => {
    expect(grade({ answer: "44，20", answerType: "numeric" }, "20，44").correct).toBe(false);
  });

  it("三个数的答案逐个比", () => {
    const q = { answer: "27;13;26", answerType: "numeric" as const };
    expect(grade(q, "27，13，26").correct).toBe(true);
    expect(grade(q, "27，13，25").correct).toBe(false);
  });

  it("带小问编号的答案：比的是答案不是题号", () => {
    // 此前抓到的是题号 1，两道题的答案都判成"1"
    const q = { answer: "( 1 ) 9021 . ( 2 ) 1909 .", answerType: "numeric" as const };
    expect(grade(q, "(1)9021,(2)1909").correct).toBe(true);
    expect(grade(q, "(1)9021,(2)1900").correct).toBe(false);
  });

  it("角度答案：比的是度数不是角标", () => {
    // 此前 ∠1=45° 抓到的是角标 1
    const q = { answer: "∠1=45°，∠2=135°", answerType: "numeric" as const };
    expect(grade(q, "∠1=45°，∠2=135°").correct).toBe(true);
    expect(grade(q, "∠1=45°，∠2=145°").correct).toBe(false);
  });

  it("每段各带单位的答案", () => {
    const q = { answer: "红筐有10个，粉筐有17个，绿筐有12个", answerType: "numeric" as const };
    expect(grade(q, "10个,17个,12个").correct).toBe(true);
    expect(grade(q, "10个,17个,13个").correct).toBe(false);
  });
});

describe("方向反了就是错", () => {
  it("参考「少22人」孩子写「多22人」→ 判错（此前判对）", () => {
    const r = grade({ answer: "少22人", answerType: "numeric" }, "多22人");
    expect(r.correct).toBe(false);
    expect(r.method).not.toBe("pending"); // 这是确凿的错，不该丢给家长
  });

  it("参考「现在大米多，多6袋」——这是一句话，不是两个答案", () => {
    const q = { answer: "现在大米多，多6袋", answerType: "steps" as const };
    expect(grade(q, "大米多6袋").correct).toBe(true);
    expect(grade(q, "面粉多6袋").correct).toBe(false);
  });

  it("孩子只写了数、没写方向 → 交给家长，不判错", () => {
    const r = grade({ answer: "少22人", answerType: "numeric" }, "22");
    expect(r.method).toBe("pending");
  });

  it("肯定与否定不能混", () => {
    expect(grade({ answer: "是", answerType: "numeric" }, "不是").correct).toBe(false);
  });
});

describe("判不准就别判", () => {
  it("文字答案对不上时转 pending，而不是判错", () => {
    const q = {
      answer: "丁丁在二小，爱好打乒乓球；田田在三小，爱好打羽毛球",
      answerType: "steps" as const,
    };
    expect(grade(q, "丁丁二小乒乓球，田田三小羽毛球").method).toBe("pending");
  });

  it("原样写对的文字答案照样算对", () => {
    const q = { answer: "今天是周三", answerType: "steps" as const };
    expect(grade(q, "今天是周三").correct).toBe(true);
  });

  it("空答案算错，不占用家长的抽检队列", () => {
    expect(grade({ answer: "26", answerType: "numeric" }, "   ").method).not.toBe("pending");
  });
});

describe("answerType 标错了也不影响判卷", () => {
  it("纯数值题被标成 steps，照样判得出来", () => {
    // 实测题库里 44，20 与 16，256 都被标成了 steps，于是孩子做对也没有反馈
    expect(grade({ answer: "16，256", answerType: "steps" }, "16，256").correct).toBe(true);
  });

  it("纯文字题被标成 expression，照样按文字判", () => {
    // 实测 13 道纯文字题被标成 expression
    expect(grade({ answer: "乙和丁", answerType: "expression" }, "乙和丁").correct).toBe(true);
  });
});

/**
 * 拿真实题库扫一遍。这两条是判卷器的地板：
 * 判不出参考答案自己，就一定判不出孩子写的；
 * 而"只答第一段判成对"正是改这一版的起因。
 */
describe("真实题库全量自检", () => {
  const dir = fileURLToPath(new URL("../../../data/knowledge/questions", import.meta.url));
  const questions = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Question[]);

  it("每道题的参考答案原样写回都判对", () => {
    const bad = questions.filter((q) => !grade(q, q.answer).correct);
    expect(bad.map((q) => q.answer)).toEqual([]);
  });

  it("多值题只答第一段一律判错", () => {
    const multi = questions.filter((q) => splitAnswerParts(q.answer).length >= 2);
    expect(multi.length).toBeGreaterThan(0);
    const leaked = multi.filter((q) => grade(q, splitAnswerParts(q.answer)[0]!).correct);
    expect(leaked.map((q) => q.answer)).toEqual([]);
  });
});

describe("deriveAnswerType：按答案本身推，不信模型的标注", () => {
  it.each([
    ["单个数", "26", "numeric"],
    ["多个数", "44，20", "numeric"],
    ["带单位", "16，256", "numeric"],
    ["数值 + 方向词", "少22人", "numeric"],
    ["一句话里含数值", "现在大米多，多6袋", "numeric"],
    ["角度带标号", "∠1=100°；∠2=50°", "numeric"],
    ["代数式", "2x+2", "expression"],
    ["多段代数式", "(a-25)元；12a+25b元", "expression"],
    ["纯文字", "乙和丁", "steps"],
    ["肯否", "是", "steps"],
    ["角的名字（有字母但不是算式）", "∠AOB，∠BOC，∠AOC", "steps"],
    ["带序号的文字清单", "1亚洲、2大洋洲、3欧洲、4非洲、5美洲", "steps"],
    ["推理题的对应关系", "刘刚与小红、马辉与小英、李强与小丽", "steps"],
  ])("%s：「%s」→ %s", (_why, answer, want) => {
    expect(deriveAnswerType(answer)).toBe(want);
  });

  it("条目序号不能让文字清单冒充数值题", () => {
    // 「1亚洲、2大洋洲…」里的 1~5 是编号；剥掉之后一个数字都不剩
    expect(deriveAnswerType("1亚洲、2大洋洲、3欧洲")).toBe("steps");
    // 而「44，20」不连号，是两个真答案
    expect(deriveAnswerType("44，20")).toBe("numeric");
    // 答案本身就是 1、2、3 的题也不能被剥空
    expect(deriveAnswerType("1，2，3")).toBe("numeric");
  });

  it("题库里每道题推出来的类型都判得动", () => {
    const dir = fileURLToPath(new URL("../../../data/knowledge/questions", import.meta.url));
    const questions = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Question[]);
    for (const q of questions) {
      const derived = deriveAnswerType(q.answer);
      // 推成 numeric/expression 的，参考答案原样写回必须判对（不能落进 pending）
      if (derived !== "steps") {
        expect(grade({ ...q, answerType: derived }, q.answer).correct, q.answer).toBe(true);
      }
    }
  });
});

/**
 * 答案不唯一。
 *
 * 第8讲 巧填算符整讲都是这类题，讲义原文就写着「答案不唯一」，
 * 还列着「方法一…方法五」。此前拿整串当一个答案比，荒唐到
 * **参考答案自己列出的第一种解法都判错**。
 */
describe("答案不唯一", () => {
  const q = (answer: string, unique?: boolean) => ({
    answer,
    answerType: deriveAnswerType(answer),
    ...(unique === false ? { answerUnique: false } : {}),
  });

  it("参考答案用「或」列了几种时，命中任一都算对", () => {
    const item = q("12×3+4=40 或 12+3×4=24");
    expect(grade(item, "12×3+4=40").correct).toBe(true);
    expect(grade(item, "12+3×4=24").correct).toBe(true);
  });

  it("参考答案没列、但同样满足条件的填法照样算对", () => {
    // 1×2×3×4 用的是同一组数字、得数也是 24——它就是一个正确解法，
    // 只是讲义没列出来。这正是"按条件验算"要救回来的那一类。
    expect(grade(q("12×3+4=40 或 12+3×4=24"), "1×2×3×4=24").correct).toBe(true);
  });

  it("每一条都被条件否掉时是确凿的错", () => {
    // 得数既不是 40 也不是 24
    expect(grade(q("12×3+4=40 或 12+3×4=24"), "1+2+3+4=10").correct).toBe(false);
  });

  it("不是算术等式的多解答案，对不上就交给家长", () => {
    expect(grade(q("甲和乙 或 丙和丁"), "甲和丙").method).toBe("pending");
  });

  it("「大于或等于」里的或不是分隔符", () => {
    expect(grade(q("大于或等于5"), "大于或等于5").correct).toBe(true);
  });

  it("标了答案不唯一的题，对不上时交给家长而不是判错", () => {
    const r = grade(q("1+2+3+4=10", false), "4+3+2+1=10");
    expect(r.correct === true || r.method === "pending").toBe(true);
  });

  it("没标不唯一的普通题，答错照样判错", () => {
    expect(grade(q("26"), "25").method).toBe("numeric");
    expect(grade(q("26"), "25").correct).toBe(false);
  });
});

/**
 * 等式类：按条件验算，不按答案比对。
 * 「使等式成立」的正确性在于满不满足条件，不在于写出来长什么样。
 */
describe("按条件验算等式", () => {
  const q = (answer: string) => ({ answer, answerType: "expression" as const });

  it("换一种同样正确的填法也算对", () => {
    // 用的数字相同、得数相同、等式自己成立 → 就是对的
    expect(grade(q("12+3×4=24"), "3×4+12=24").correct).toBe(true);
    expect(grade(q("1+2+3+4=10"), "4+3+2+1=10").correct).toBe(true);
  });

  it("等式自己不成立 → 判错", () => {
    expect(grade(q("1+2+3+4=10"), "1+2+3+4=11").correct).toBe(false);
  });

  it("得数不是题目要求的那个 → 判错", () => {
    expect(grade(q("1+2+3+4=10"), "1×2×3×4=24").correct).toBe(false);
  });

  it("用了题目没给的数字 → 判错", () => {
    // 凑出 10 了，但用的是 5、5，不是题目给的 1、2、3、4
    expect(grade(q("1+2+3+4=10"), "5+5=10").correct).toBe(false);
  });

  it("1、2 拼成 12 与拆开用都认（比的是数位不是数）", () => {
    expect(equationSatisfiesCondition("12+3×4=24", "12+3×4=24")).toBe(true);
    expect(equationSatisfiesCondition("12+3×4=24", "1×2+3×4=14")).toBe(false);
  });

  it("带括号的填法", () => {
    expect(grade(q("(1+2)×3+4=13"), "4+3×(2+1)=13").correct).toBe(true);
  });
});
