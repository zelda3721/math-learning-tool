/**
 * 自由生成的 HTML 组件：沙箱与收口规则。
 *
 * PLAN 允许"自由生成的 HTML 作为兜底"，但兜底不能是一个能随便跑的页面——
 * 它的作者是模型，输入是孩子的机器。这里做的是**白名单式收口**：
 *
 * 1. 只许内联脚本，不许加载任何外部东西（外链脚本/样式/字体/图片）；
 * 2. 不许联网（fetch / XHR / WebSocket / EventSource / sendBeacon）；
 * 3. 不许跳出沙箱（top / parent / opener）、不许读 cookie 与本地存储；
 * 4. 不许动态执行（eval / new Function / import()）；
 * 5. 不许再套 iframe、不许提交表单。
 *
 * 校验通过也不代表可信——真正的边界是 iframe 的 `sandbox` 属性与 CSP 两把锁，
 * 这里只是把它们之外的常见坏味道提前挡掉。**两道锁都要**：CSP 挡网络与外链，
 * sandbox 挡同源与脚本越权，缺一条都不算沙箱。
 */

const MAX_HTML_CHARS = 200_000;

/** 危险写法 → 为什么危险（报错里带上原因，家长/调试一眼看懂） */
const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /<script[^>]*\bsrc\s*=/i, why: "不允许加载外部脚本" },
  { pattern: /\bimport\s*\(/i, why: "不允许动态 import" },
  { pattern: /\beval\s*\(/i, why: "不允许 eval" },
  { pattern: /\bnew\s+Function\b/i, why: "不允许 new Function" },
  { pattern: /\bfetch\s*\(/i, why: "不允许联网（fetch）" },
  { pattern: /\bXMLHttpRequest\b/i, why: "不允许联网（XHR）" },
  { pattern: /\bWebSocket\b/i, why: "不允许联网（WebSocket）" },
  { pattern: /\bEventSource\b/i, why: "不允许联网（EventSource）" },
  { pattern: /\bsendBeacon\b/i, why: "不允许联网（sendBeacon）" },
  { pattern: /document\s*\.\s*cookie/i, why: "不允许读 cookie" },
  { pattern: /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/i, why: "不允许用本地存储" },
  { pattern: /\bwindow\s*\.\s*(?:top|parent|opener)\b/i, why: "不允许跳出沙箱" },
  { pattern: /javascript\s*:/i, why: "不允许 javascript: 链接" },
  { pattern: /<iframe\b/i, why: "不允许再套 iframe" },
  { pattern: /<form\b/i, why: "不允许表单提交" },
  { pattern: /<(?:script|link|img)[^>]+(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i, why: "不允许外链资源" },
];

export interface HtmlValidation {
  ok: boolean;
  errors: string[];
}

export function validateWidgetHtml(html: string): HtmlValidation {
  const errors: string[] = [];
  if (!html.trim()) errors.push("HTML 是空的");
  if (html.length > MAX_HTML_CHARS) errors.push(`HTML 太大（${html.length} 字符，上限 ${MAX_HTML_CHARS}）`);
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(html)) errors.push(rule.why);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 沙箱 iframe 的 CSP。
 *
 * `script-src 'unsafe-inline'` 是必要的（组件就是内联的），所以网络与同源必须掐死：
 * `default-src 'none'` + `connect-src 'none'` + `frame-src 'none'` + `base-uri 'none'`，
 * 图片只允许 data:（画图常用 canvas/SVG 内联，不需要外链）。
 */
export function widgetCsp(): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src 'none'",
    "connect-src 'none'",
    "media-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/** iframe 的 sandbox 属性：不给 allow-same-origin，脚本就碰不到本站的任何东西 */
export function widgetSandboxAttr(): string {
  return "allow-scripts";
}
