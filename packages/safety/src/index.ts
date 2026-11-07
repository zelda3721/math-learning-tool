/**
 * 内容安全：家长不在场时，谁替他把关。
 *
 * 这一层**不调用模型**，是刻意的：用模型来判断"这句话该不该给孩子看"，
 * 等于把安全托付给一个会说谎、会被诱导、还会变化的组件。规则是笨的、可读的、
 * 可被家长逐条审的——笨正好，因为它要能被理解和复核，而不是聪明。
 *
 * 三种裁决，而不是两种：
 * - `allow`   放行
 * - `redirect` 不该聊，但不必惊动家长：给一句固定话术，把话题带回学习
 *   （孩子问"今天有什么游戏"不是错误，直接封死只会让他换着法子绕）
 * - `block`   必须停下来：涉及个人信息、自伤、色情暴力，以及"直接要答案"
 *   这类把学习掏空的行为。block 会记进家长可见的日志。
 *
 * 判断顺序是**先重后轻**：越界话题的词表和隐私词表有重叠，先判重的，
 * 免得"我住哪儿，顺便问个数学题"被轻判放过。
 */

export type SafetyAction = "allow" | "redirect" | "block";

export type SafetyReason =
  /** 个人信息 / 联系方式探询或被探询 */
  | "privacy"
  /** 试图约见、索要照片、加社交软件 */
  | "contact-request"
  /** 自伤、暴力、色情等不适宜内容 */
  | "unsafe-content"
  /** 诱导直接要答案，跳过思考 */
  | "answer-seeking"
  /** 与学习无关的话题（游戏、追星、短视频…） */
  | "off-topic";

export interface SafetyVerdict {
  action: SafetyAction;
  reason?: SafetyReason;
  /** 给孩子的固定话术：不是模型现编的，家长可以逐字审 */
  reply?: string;
  /** 命中的词（日志用；不把命中词回给孩子，避免"试探边界"的游戏） */
  matched?: string[];
}

/** 固定话术：短、不带说教腔、都给下一步动作 */
const REPLIES: Record<SafetyReason, string> = {
  privacy:
    "我还不能聊你或家里人的个人信息——名字、住址、学校、电话这些都不聊。想说说数学题吗？",
  "contact-request":
    "我们不能约见面，也不能加微信、QQ。我只是一台跑在你家电脑上的程序，我们就在这儿聊数学吧。",
  "unsafe-content":
    "这个话题我不能跟你展开。如果有什么让你难受的事，去跟爸爸妈妈说，他们才是能帮到你的人。",
  "answer-seeking":
    "答案我不直接给——不过我可以用一个问题帮你往前挪一步。你先把已经想到的那一步说来听听？",
  "off-topic": "这个我不太懂，我是陪你学数学的。要不我们回到刚才那道题，或者换个你会卡住的题？",
};

/** 重的先判：命中任意一条就按它走 */
const RULES: { reason: SafetyReason; action: SafetyAction; patterns: RegExp[] }[] = [
  {
    reason: "unsafe-content",
    action: "block",
    patterns: [
      /自杀|自残|割腕|不想活|活着没意思|跳楼/,
      /杀掉|杀人|怎么打人|报复同学|带刀|炸药|炸弹|制作枪支/,
      /色情|裸照|涩涩|做爱|裸体/,
      /毒品|大麻|吸毒|喝酒喝醉/,
    ],
  },
  {
    reason: "contact-request",
    action: "block",
    patterns: [
      /微信|wechat|qq\s*号|加我qq|加个好友|私聊/i,
      /约(?:你|我)?见面|出来见一面|在哪见面/,
      /发张照片|发个自拍|你的照片/,
      // 「你家住在哪里呀」「你住在哪」都是同一个问题，别只认紧挨着的那种写法
      /你家.{0,4}哪|你住(?:在)?哪|你父母的电话/,
    ],
  },
  {
    reason: "privacy",
    action: "block",
    patterns: [
      /我(?:家)?住(?:在)?[^。？?]{0,12}(?:路|街|小区|号|栋|楼)/,
      /我(?:是|在)[^。？?]{0,8}(?:小学|中学|附小|附中)[^。？?]{0,6}(?:上学|读书|班)/,
      /我的(?:手机|电话|身份证|密码)/,
      /(?:1[3-9]\d{9})|(?:\d{6,})@/,
    ],
  },
  {
    reason: "answer-seeking",
    action: "redirect",
    patterns: [
      /直接(?:告诉|给)我答案|把答案(?:给|告诉)我|答案是多少|直接说答案|别(?:讲|解释)了?直接给答案/,
      /(?<!不知道)答案是几/,
      /我不想(?:算|想)了[,，]?\s*(?:给|告诉)我(?:结果|答案)/,
    ],
  },
  {
    reason: "off-topic",
    action: "redirect",
    patterns: [
      /游戏|王者|吃鸡|原神|我的世界|蛋仔/,
      /抖音|快手|短视频|追星|偶像|明星|演唱会|饭圈/,
      /动漫|番剧|cosplay/,
      /球赛|世界杯|nba/i,
    ],
  },
];

/** 命中即放行：题目本身带着"游戏""明星"这类词是完全正常的（例：明星演唱会的门票钱） */
const MATH_SIGNALS =
  /多少|几(?:个|只|元|米|厘米|分钟|天)|计算|解方程|求|面积|周长|分数|小数|方程|比例|平均|余数|速度|总价|一共|还剩|证明|函数|几何|概率|统计/;

/**
 * 孩子输入侧安检。
 *
 * 数学信号优先的例外只给 `off-topic`：它最轻，误伤的代价最大——
 * 一道"演唱会门票多少元"的题被打回去，孩子会觉得这个系统根本不懂数学。
 * 隐私、自伤、要答案这几类**不因为句子里有数字就放行**。
 */
export function screenInput(raw: string): SafetyVerdict {
  const text = raw.trim();
  if (!text) return { action: "allow" };

  for (const rule of RULES) {
    const matched = rule.patterns.filter((p) => p.test(text)).map((p) => p.source);
    if (matched.length === 0) continue;
    if (rule.reason === "off-topic" && MATH_SIGNALS.test(text)) continue;
    return { action: rule.action, reason: rule.reason, reply: REPLIES[rule.reason], matched };
  }

  return { action: "allow" };
}

/**
 * 模型输出侧安检：只拦**确定的**泄露与承诺。
 *
 * 输出侧不做过词表过滤：把"暴力"这类词从数学解答里抠掉，会把正常的题目解析
 * 撕成断句（"从 12 个里拿走 4 个"没有问题）。这里只拦两类：联系方式（不该出现）
 * 和上门/见面的承诺（不该承诺）。
 */
export function screenOutput(raw: string): SafetyVerdict {
  const text = raw.trim();
  if (!text) return { action: "allow" };

  const contact = /(?:1[3-9]\d{9})|(?:微信|QQ)\s*[:：]?\s*[A-Za-z0-9_-]{4,}/i.exec(text);
  if (contact) {
    return {
      action: "block",
      reason: "contact-request",
      reply: "",
      matched: [contact[0].slice(0, 6)],
    };
  }
  if (/(?:我(?:可以)?(?:去|来)(?:接|找)?你|我们见面|到你家|去你家|来你家)/.test(text)) {
    return { action: "block", reason: "contact-request", reply: "", matched: ["meet"] };
  }
  return { action: "allow" };
}

/** 每天允许的对话时长（分钟）：按学段给默认值，家长可改 */
export const DEFAULT_DAILY_CHAT_MINUTES = { primary: 20, middle: 30, high: 40 } as const;

export type AgeBand = keyof typeof DEFAULT_DAILY_CHAT_MINUTES;

/**
 * 时长闸：今天已经聊了多少，还能不能开始下一轮。
 *
 * 用"开始前就拦"而不是"聊到一半掐断"：半句话被截断对孩子是最糟的体验，
 * 而且他不知道自己错在哪。提前告诉他"今天的时间用完了，明天再来"才是可理解的。
 */
export function checkTimeBudget(
  usedMinutes: number,
  limitMinutes: number,
): { allowed: boolean; remainingMinutes: number } {
  const remaining = Math.max(0, limitMinutes - usedMinutes);
  return { allowed: remaining > 0, remainingMinutes: remaining };
}
