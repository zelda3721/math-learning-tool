import type { Judge, SubjectPackage } from "./types.js";

export class RegistryError extends Error {}

/**
 * 学科注册表。
 *
 * 唯一的职责：把"这件事归谁做"变成一次查表，而不是一串 if (subject === "math")。
 *
 * 三条纪律：
 * 1. **id 全局唯一**。两个学科包用同一个判卷器 id 是配置错误，不是覆盖语义——
 *    覆盖会让人以为改动生效了，实际生效的是别处那一份。
 * 2. **判卷器必须声明它判什么题型**，内核不替它猜"都能判"。
 *    猜的后果是：新题型进来时，恰好有个判卷器"看起来能判"，
 *    于是它被拿去判一件它不懂的事，还判得头头是道。
 * 3. **查不到就返回 undefined，不抛异常**。调用方要知道的是"没有判卷器"，
 *    据此走 pending / 家长确认；在这里抛异常只会把一条正常的产品路径变成长串 try/catch。
 */
export class SubjectRegistry {
  private readonly subjects = new Map<string, SubjectPackage>();
  private readonly judges = new Map<string, Judge>();
  /** 题型 → 判卷器（一个题型可以有多个，按登记顺序取第一个） */
  private readonly judgesByItemType = new Map<string, Judge[]>();

  register(pkg: SubjectPackage): void {
    if (this.subjects.has(pkg.id)) {
      throw new RegistryError(`学科重复注册: ${pkg.id}`);
    }
    this.subjects.set(pkg.id, pkg);

    for (const judge of pkg.judges) {
      if (judge.subject !== pkg.id) {
        throw new RegistryError(`判卷器 ${judge.id} 声明属于 ${judge.subject}，却注册在 ${pkg.id} 下`);
      }
      if (this.judges.has(judge.id)) {
        throw new RegistryError(`判卷器 id 重复: ${judge.id}`);
      }
      this.judges.set(judge.id, judge);
      for (const itemType of judge.itemTypes) {
        const bucket = this.judgesByItemType.get(itemType) ?? [];
        bucket.push(judge);
        this.judgesByItemType.set(itemType, bucket);
      }
    }
  }

  get(subject: string): SubjectPackage | undefined {
    return this.subjects.get(subject);
  }

  list(): SubjectPackage[] {
    return [...this.subjects.values()];
  }

  judgeById(id: string): Judge | undefined {
    return this.judges.get(id);
  }

  /** 某题型的判卷器（登记顺序里的第一个） */
  judgeForItemType(itemTypeId: string): Judge | undefined {
    return this.judgesByItemType.get(itemTypeId)?.[0];
  }

  /**
   * 按学科 + 题型找判卷器。
   *
   * 只给学科时：该学科下恰好有一个判卷器才返回它；有多个就返回 undefined——
   * "随便挑一个"在这里是错的，挑错了就是拿语文的标准判数学。
   */
  judgeFor(subject: string, itemTypeId?: string): Judge | undefined {
    const pkg = this.subjects.get(subject);
    if (!pkg) return undefined;
    if (itemTypeId) {
      const judge = this.judgeForItemType(itemTypeId);
      return judge && judge.subject === subject ? judge : undefined;
    }
    return pkg.judges.length === 1 ? pkg.judges[0] : undefined;
  }
}
