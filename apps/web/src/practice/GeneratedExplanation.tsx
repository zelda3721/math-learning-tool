/**
 * 模型直写的讲解页面。
 *
 * 这份 HTML 是模型生成的代码，**绝不能与主站同源执行**。所以：
 * - `sandbox={EXPLANATION_SANDBOX}` 且**不给** `allow-same-origin`——文档落在不透明源里，
 *   读不到 cookie、localStorage，也碰不到父页面。两者一起给等于没有沙箱。
 * - 服务端在响应头上还压了一层 CSP（`connect-src 'none'`），门禁万一漏了也拉不到外面去。
 * - 高度只能固定：跨源量不到内容高度，所以给足视口让页面自己在内部滚动。
 *
 * 真实性由引擎侧的契约门禁保证（宣称的数量必须真的画出来、答案不许画错），
 * 不合规的页面根本不会被登记，也就不会走到这里。
 */
/**
 * 沙箱策略：只给脚本，**绝不给 allow-same-origin**。
 * 两者同时给等于没有沙箱——文档会拿回主站源，模型写的 JS 就能读会话 cookie。
 * 提成常量是为了让它可被测试锁住：改坏了要红，而不是悄悄上线。
 */
export const EXPLANATION_SANDBOX = 'allow-scripts'

interface Props {
    htmlUrl: string
    /** 讲解质量：有未处理建议时为 acceptable */
    quality?: string
}

export function GeneratedExplanation({ htmlUrl, quality }: Props) {
    return (
        <div className="space-y-2">
            <div className="rounded-[10px] border border-rule overflow-hidden bg-plate">
                <iframe
                    src={htmlUrl}
                    title="动态讲解"
                    sandbox={EXPLANATION_SANDBOX}
                    referrerPolicy="no-referrer"
                    loading="lazy"
                    className="w-full block border-0 h-[clamp(420px,62vh,640px)]"
                />
            </div>
            <p className="text-xs text-ink-faint px-1">
                这页讲解由模型现写，数量与答案已经过核对
                {quality === 'acceptable' ? '（有少量建议未处理）' : ''}。
            </p>
        </div>
    )
}
