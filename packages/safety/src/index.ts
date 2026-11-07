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
  "off-topic": "这个我不太懂，我是陪你学习的。要不我们回到刚才那道题，或者换个你会卡住的题？",
};

/**
 * 规则匹配前的归一化。
 *
 * 以前是拿原文直接跑正则，于是同一句话换个写法就过：`自 杀`（插空格）、`自殺`（繁体）、
 * `I want to kill myself`（英文）、`你的vx多少`（缩写）。孩子不需要懂安全工程，
 * 打字习惯和错别字就足够绕过——"词表覆盖到了"和"拦得住"是两件事。
 *
 * 归一化只做**不改变意思**的等价：全角转半角（NFKC）、大小写、去空白与标点、
 * 常见繁体字与异体字映射。不做拼音/谐音/形近替换的猜测——那会把判断变成模糊匹配，
 * 而模糊匹配在题目上会误伤（"分"和"份"在数学题里是两回事）。
 *
 * 两个视图，因为中英文对空白的敏感度相反：
 * - `tight`：去掉所有空白与标点，中文按字命中（`自 杀`、`自，杀` 都变 `自杀`）；
 * - `spaced`：空白折叠成一个空格，英文按词命中（不然 `killmyself` 也会误伤长度词）。
 */
export function normalizeForMatching(raw: string): { tight: string; spaced: string } {
  const base = raw.normalize("NFKC").toLowerCase();
  const spaced = base.replace(/\s+/g, " ").trim();
  const tight = spaced
    .replace(/[\s·・.,，。!！?？、;；:：~～\-—_*…'"“”‘’()（）【】\[\]{}<>《》/\\|]/g, "")
    // 繁体与常见异体：只映射这批安全词里会出现的字，不做整段繁简转换
    .replace(/[殺]/g, "杀")
    .replace(/[殘]/g, "残")
    .replace(/[腕]/g, "腕")
    .replace(/[藥]/g, "药")
    .replace(/[槍]/g, "枪")
    .replace(/[彈]/g, "弹")
    .replace(/[盡]/g, "尽")
    .replace(/[膚]/g, "肤")
    .replace(/[戀]/g, "恋")
    .replace(/[戲]/g, "戏");
  return { tight, spaced };
}

/**
 * 重的先判：命中任意一条就按它走。
 *
 * `patterns` 跑在 tight（中文裸字）上，`english` 跑在 spaced（英文按词）上。
 * 中文侧写成不带空白的样子——归一化已经把空白去掉了，写 `自 杀` 反而永远匹配不上。
 */
const RULES: {
  reason: SafetyReason;
  action: SafetyAction;
  patterns: RegExp[];
  english?: RegExp[];
}[] = [
  {
    reason: "unsafe-content",
    action: "block",
    patterns: [
      // 「我想死」「想去死」是最常见的求救说法，旧词表只认「不想活」
      /自杀|自残|割腕|跳楼|上吊|轻生|结束生命|不想活|活着没意思|活着没意义/,
      /想死(?!记|背|你)|去死(?!记|背)|死了算了/,
      /杀掉|杀人|怎么打人|报复同学|带刀|炸药|炸弹|制作枪支|放火|投毒/,
      /色情|裸照|涩涩|做爱|裸体|黄片|黄色网站/,
      /毒品|大麻|吸毒|冰毒|海洛因|喝酒喝醉/,
    ],
    english: [
      /\bkill\s*(?:ing)?\s*myself\b/,
      /\bsuicid/,
      /\bself[-\s]?harm/,
      /\b(?:want|wanna|going)\s+to\s+die\b/,
      /\bcut(?:ting)?\s+(?:my\s+)?wrists?\b/,
      /\bhurt\s+myself\b/,
      /\b(?:make|build)\s+a\s+bomb\b/,
      /\bhow\s+to\s+(?:kill|poison|hurt)\b/,
      /\bporn|nudes?\b|\bnaked\b/,
      /\b(?:drugs?|cocaine|heroin|weed)\b/,
    ],
  },
  {
    reason: "contact-request",
    action: "block",
    patterns: [
      /微信|wechat|qq|扣扣|私聊|加个好友|加好友|互关/,
      // 加个v / 留个vx / 你的vx多少：前面加个汉字，"加个v"就不在句首了
      /(?<![增添])(?:加|留|发|给)(?:个|下|一下|我|你)*v(?:x|信)?(?![a-z0-9])/,
      /(?:你的|你)?vx(?:号|多少)/,
      /约(?:你|我)?见面|出来见一面|在哪见面|见一面吧|见面吧|见个面|见面聊|我们见面/,
      /发张照片|发个自拍|你的照片|看看你长什么样/,
      // 「你家住在哪里呀」「你住在哪」都是同一个问题，别只认紧挨着的那种写法
      /你家.{0,4}哪|你住(?:在)?哪|你父母的电话/,
    ],
    english: [
      /\bwechat|whats\s*app|instagram|snapchat|telegram\b/,
      /\bqq\b/i,
      /\b(?:your|ur)\s+(?:phone|number|wechat|qq)\b/,
      /\b(?:let'?s|can\s+we)\s+meet\b|\bmeet\s+up\b/,
      /\bsend\s+(?:me\s+)?(?:a\s+)?(?:photo|selfie|pic|picture)\b/,
      /\bwhere\s+do\s+you\s+live\b/,
      /\bwhere\s+(?:is|is\s+your)\s+school\b/,
    ],
  },
  {
    reason: "privacy",
    action: "block",
    patterns: [
      /我(?:家)?住(?:在)?[^。？?]{0,12}(?:路|街|小区|号|栋|楼)/,
      /我(?:是|在)[^。？?]{0,8}(?:小学|中学|附小|附中)[^。？?]{0,6}(?:上学|读书|班)/,
      /我的(?:手机|电话|身份证|密码|地址|学校)/,
      /(?:1[3-9]\d{9})|(?:\d{6,})@/,
    ],
    english: [
      /\bmy\s+(?:phone|address|password|school)\b/,
      /\b\d{3}[-.\s]?\d{3,4}[-.\s]?\d{4}\b/,
      /\bi\s+live\s+(?:at|in)\s+\d/,
    ],
  },
  {
    reason: "answer-seeking",
    action: "redirect",
    patterns: [
      /直接(?:告诉|给)我答案|把答案(?:给|告诉)我|答案是多少|直接说答案|别(?:讲|解释)了?直接给答案/,
      /(?<!不知道)答案是几/,
      /我不想(?:算|想)了[,，]?\s*(?:给|告诉)我(?:结果|答案)/,
      /告诉我(?:结果|答案)|把结果给我|给个答案|答案给我|答案多少|答案是什么|答案是啥/,
      /选哪个|选[a-d]|选第几/,
    ],
    english: [
      /\b(?:just\s+)?(?:give|tell)\s+me\s+the\s+answer\b/,
      /\bwhat'?s\s+the\s+answer\b/,
      /\bdon'?t\s+explain.*\banswer\b/,
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
    english: [
      /\bvideo\s*games?|fortnite|minecraft|roblox\b/,
      /\btik\s*tok|k-?pop|anime\b/,
    ],
  },
];

/** 命中即放行：题目本身带着"游戏""明星"这类词是完全正常的（例：明星演唱会的门票钱） */
const MATH_SIGNALS =
  /多少|几(?:个|只|元|米|厘米|分钟|天)|计算|解方程|求|面积|周长|分数|小数|方程|比例|平均|余数|速度|总价|一共|还剩|证明|函数|几何|概率|统计/;

/** 英文题面的数学信号：英语题也开始进产品了，不能只认中文的"多少" */
const MATH_SIGNALS_EN =
  /\bhow\s+many|how\s+much|calculate|compute|what\s+is\s+\d|area|perimeter|fraction|fractions|decimal|solve|equation|percent|percentage|average|ratio|speed|total\b/;

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
  const { tight, spaced } = normalizeForMatching(text);
  const isMath = MATH_SIGNALS.test(tight) || MATH_SIGNALS_EN.test(spaced);

  for (const rule of RULES) {
    const matched: string[] = [];
    for (const p of rule.patterns) if (p.test(tight)) matched.push(p.source);
    for (const p of rule.english ?? []) if (p.test(spaced)) matched.push(p.source);
    if (matched.length === 0) continue;
    // 数学信号优先只豁免 off-topic：它最轻，误伤代价最大
    if (rule.reason === "off-topic" && isMath) continue;
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
  // 输出侧同样要归一化：模型把手机号写成「138 1234 5678」照样是泄露
  const { tight } = normalizeForMatching(text);

  const contact = /(?:1[3-9]\d{9})|(?:微信|qq)[:：]?[A-Za-z0-9_-]{4,}/i.exec(tight);
  if (contact) {
    return {
      action: "block",
      reason: "contact-request",
      reply: "",
      matched: [contact[0].slice(0, 6)],
    };
  }
  if (/(?:我(?:可以)?(?:去|来)(?:接|找)?你|我们见面|到你家|去你家|来你家|在你家楼下|你学校门口)/.test(tight)) {
    // 归一化后的文本没有空格，中文规则照旧按裸字写
    return { action: "block", reason: "contact-request", reply: "", matched: ["meet"] };
  }
  // 英文输出也要拦：英语课的讲解同样是模型生成的，它一样可能写出见面承诺
  const { spaced } = normalizeForMatching(text);
  if (/\b(?:meet\s+(?:you|me)\s+(?:at|near|outside)|near\s+your\s+home|outside\s+your\s+school|come\s+to\s+your\s+(?:home|house|school))\b/.test(spaced)) {
    return { action: "block", reason: "contact-request", reply: "", matched: ["meet-en"] };
  }
  return { action: "allow" };
}

/**
 * 连续用多久提醒休息（分钟）。
 *
 * 写成常量而不是配置项：它不是家长要调的东西，而是产品该守住的一条线——
 * 一个小时不抬头，对小学生是"该出去玩了"，不是"再学一会儿"。
 * 家长可调的只有每天的上限（`DEFAULT_DAILY_CHAT_MINUTES` 与手填值）。
 */
export const BREAK_AFTER_MINUTES = 40;

/** 这次连续使用是不是该歇一下了 */
export function shouldSuggestBreak(continuousMinutes: number, after = BREAK_AFTER_MINUTES): boolean {
  return continuousMinutes >= after;
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
