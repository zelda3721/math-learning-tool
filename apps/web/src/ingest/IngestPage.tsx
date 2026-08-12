/**
 * 录题页（P1a 单发 + P1b 批量/抽检）：
 * - 「录入」tab：单份（粘贴文本/图片/PDF → /upload）或批量（多文件 → /batch + 任务轮询），
 *   两条路径共用草稿编辑列表与 /confirm 入库。
 * - 「抽检」tab：家长抽检 extracted 题目（核验通过/剔除/跳过）。
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { BatchPanel } from './BatchPanel'
import type { BatchOutcome, PairingReport } from './BatchPanel'
import { ReviewTab } from './ReviewTab'
import { Button, PageHeader } from '../ui'
import {
    ANSWER_TYPE_LABELS,
    dropzoneCls,
    extractErrorMessage,
    fileInputCls,
    inputCls,
    LEVEL_LABELS,
    applyTail,
    carryableText,
    looksLikeQuestion,
    mergeContinued,
    normalizeDraft,
    readFileAsDataUrl,
    todayString,
} from './shared'
import type { AnswerType, ConfirmResult, Draft, Level } from './shared'
import { pdfToPages } from './pdfPages'
import { cropPage, figureCropBox, FIGURE_PAD } from './crop'

type IngestKind = 'text' | 'image' | 'pdf'
type IngestTab = 'input' | 'review'
type InputMode = 'single' | 'batch'

/** 分层识别的四个阶段，进度条上要分得清是在渲染、切题还是读题 */
type PdfPhase = 'render' | 'layout' | 'question' | 'extract'
/**
 * 页首留出多少空白才算"这块内容不属于本页任何一道题"。
 * 正常起始的题从 0.05 上下开始；到了 0.15 以上，上面那一截必然是上一页的尾巴。
 */
const LEAD_MIN = 0.15

/**
 * 一道题的框占到整页多高，就该怀疑里面还藏着一道。
 *
 * snapBoxes 会把每道题的框补到下一道题开头，所以版面那趟漏报一道时，
 * 前一道的框会一路吃到被漏那道的下面——高度直接翻倍。实测第10讲：
 * 正常两道题各占 0.39 与 0.40，漏掉一道就会变成 0.84。
 * 0.6 是这两档之间的空档，宽松取值，误触发也只是多跑一次调用。
 */
const OVERSIZED = 0.6

const PHASE_LABEL: Record<PdfPhase, string> = {
    render: '渲染页面',
    layout: '切分题目',
    question: '逐题识别',
    extract: '整页识别',
}

/** 版面里的一道题（服务端 /layout 的返回，见 ingest/passes.ts） */
interface LayoutItem {
    index: number
    label: string
    preview: string
    box?: [number, number, number, number]
    hasFigure: boolean
    /** 服务端 classifyFigures 判好的：题干图 / 解析图 */
    stemFigureBox?: [number, number, number, number]
    analysisFigureBox?: [number, number, number, number]
    continued: boolean
    /** 这一条只有题号、没有题干——下一页那道题的头 */
    dangling?: boolean
}

/**
 * 逐页战报。
 *
 * 抽少了题时，只知道"一共 8 道"是查不出原因的——版面那趟报了几条、
 * 丢了几条光杆题号、补漏有没有触发、哪一页整页兜底了，这些才指得出问题在哪。
 * 此前排查全靠猜，来回改了三轮。
 */
interface PageReport {
    page: number
    /** 版面那趟报了几条 */
    layout: number
    /** 其中被当作光杆题号（正文翻到下一页）丢掉的 */
    dangling?: string
    /** 最终抽到几道 */
    got: number
    /** 走了整页兜底 */
    fallback?: boolean
    /** 补漏补出了几道 */
    rescued?: number
    note?: string
}

interface BatchReport {
    pairing?: PairingReport
    warnings: string[]
}

function uploadNotReadyHint(kind: IngestKind): string {
    if (kind === 'text') return '服务端抽题流水线尚未就绪（文本抽题需要配置 LLM）。'
    return `服务端抽题流水线尚未就绪（${kind === 'image' ? '图片' : 'PDF'}抽题需要配置 LLM）。`
}

/** 分段控件：录入/抽检、单份/批量、文本/图片/PDF 共用同一套语汇 */
function Segmented<T extends string>({
    value,
    options,
    onChange,
}: {
    value: T
    options: readonly (readonly [T, string])[]
    onChange: (next: T) => void
}) {
    return (
        <div className="inline-flex items-center gap-1 rounded-[10px] border border-rule bg-plate p-1">
            {options.map(([v, label]) => (
                <button
                    key={v}
                    type="button"
                    onClick={() => onChange(v)}
                    aria-pressed={value === v}
                    className={`px-4 py-1.5 rounded-[7px] text-sm font-medium whitespace-nowrap transition-colors ${
                        value === v ? 'bg-beam text-white' : 'text-ink-soft hover:text-ink'
                    }`}
                >
                    {label}
                </button>
            ))}
        </div>
    )
}

export function IngestPage() {
    const [tab, setTab] = useState<IngestTab>('input')
    const [mode, setMode] = useState<InputMode>('single')
    const [kind, setKind] = useState<IngestKind>('text')
    // PDF 逐页渲染 + 识别的进度与说明（整本讲义要跑一两分钟，不能只转个圈）
    const [pdfProgress, setPdfProgress] = useState<{
        done: number
        total: number
        phase: PdfPhase
    } | null>(null)
    const [pdfNote, setPdfNote] = useState<string | null>(null)
    // 版面框的可用率：低了就该换模型，所以这个数必须摆到台面上
    const [boxStat, setBoxStat] = useState<{ total: number; withBox: number } | null>(null)
    const [pageReports, setPageReports] = useState<PageReport[]>([])
    const [text, setText] = useState('')
    const [file, setFile] = useState<File | null>(null)
    const [batchName, setBatchName] = useState(todayString())
    /**
     * 材料的学段。不选的话知识点候选清单是全量 123 个（4099 字），
     * 既费 token，又诱导模型跨学段乱选——一道小学数图形的题被判成
     * 高中「解三角形」，我们见过（见服务端 vocabulary.ts）。
     */
    const [level, setLevel] = useState<Level>('elementary_upper')
    const [extracting, setExtracting] = useState(false)
    const [confirming, setConfirming] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [drafts, setDrafts] = useState<Draft[]>([])
    const [batchReport, setBatchReport] = useState<BatchReport | null>(null)
    const [result, setResult] = useState<ConfirmResult | null>(null)
    const fileInputRef = useRef<HTMLInputElement | null>(null)

    const canExtract = useMemo(() => {
        if (extracting) return false
        return kind === 'text' ? text.trim().length > 0 : file !== null
    }, [kind, text, file, extracting])

    const switchKind = (next: IngestKind) => {
        setKind(next)
        setFile(null)
        setError(null)
        if (fileInputRef.current) fileInputRef.current.value = ''
    }

    /** 调一次上传端点，返回规范化后的草稿 */
    const uploadOnce = async (payload: { kind: IngestKind; content: string }): Promise<Draft[]> => {
        const res = await fetch('/api/v1/ingest/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...payload, batchName, level }),
        })
        if (!res.ok) throw new Error(await extractErrorMessage(res, uploadNotReadyHint(payload.kind)))
        const body = (await res.json()) as { drafts?: unknown[] }
        return (body.drafts ?? []).map(normalizeDraft).filter((d): d is Draft => d !== null)
    }

    /** 第一趟：这一页有哪几道题、各在哪、有没有图 */
    const fetchLayout = async (
        pageDataUrl: string,
        previousEndedWithLabel: boolean,
    ): Promise<LayoutItem[]> => {
        const res = await fetch('/api/v1/ingest/layout', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: pageDataUrl, previousEndedWithLabel }),
        })
        if (!res.ok) throw new Error(await extractErrorMessage(res, '服务端不支持分层识别。'))
        const body = (await res.json()) as { items?: LayoutItem[] }
        return body.items ?? []
    }

    /**
     * 这一页开头那块没人认领的内容 —— 上一页那道题的尾巴。
     *
     * 版面那趟经常整块跳过它（"不是题"），而上一页那道题的答案就在里面。
     * 判据不靠模型：第一道题从哪儿开始，之前的就是尾巴。
     */
    const fetchTail = async (payload: { content: string; carryOver?: string }) => {
        const res = await fetch('/api/v1/ingest/tail', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        })
        if (!res.ok) throw new Error(await extractErrorMessage(res, '服务端不支持分层识别。'))
        const body = (await res.json()) as {
            tail?: { answer?: string; answerUnverified?: boolean; analysis?: string; hasFigure?: boolean } | null
        }
        return body.tail ?? null
    }

    /** 第二趟（服务端顺带跑第三趟配图）：一道题的内容 */
    const fetchQuestion = async (payload: {
        content: string
        hasFigure: boolean
        carryOver?: string
    }): Promise<Draft | null> => {
        // 带上学段：不带的话知识点候选清单是全量 123 个（4099 字），
        // 既费 token 又诱导模型跨学段乱选（见 vocabulary.ts 的 candidateNodes）
        const res = await fetch('/api/v1/ingest/question', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...payload, level }),
        })
        if (!res.ok) throw new Error(await extractErrorMessage(res, '服务端不支持分层识别。'))
        const body = (await res.json()) as { draft?: unknown }
        return body.draft ? normalizeDraft(body.draft) : null
    }

    /**
     * 一页的分层识别：切题 → 逐题读 → （带图的）补配图。
     *
     * 此前是一页一次调用，那一次要模型同时切题、读内容、判难度、挂知识点、
     * 写图形规格。实机上的每个失败都能追到这里：输出必然长（截断整页颗粒无收）、
     * 图形规格写在"顺便再干四件事"里（字段名飘移）、每页独立（跨页题接不上）。
     *
     * 拆开之后每趟输出都短，而短就是不截断。
     * 拿不到版面就退回整页老路——分层是为了更准，不是为了少一条退路。
     */
    const extractPageLayered = async (
        pageDataUrl: string,
        /** 上一页最后那道题：这一页开头若是它的续文，两半要合成一道 */
        previous: Draft | undefined,
        /**
         * 上一页页脚那条只有题号的窄带（正文翻到了这一页）。
         * 连它的文字一起带过来：判错时也只是多带几个字，不会丢内容。
         */
        pending: { label: string; preview: string } | undefined,
    ): Promise<{
        drafts: Draft[]
        mergedFirst: boolean
        boxes: { total: number; withBox: number }
        pending: { label: string; preview: string } | undefined
        rescued: number
    }> => {
        const items = await fetchLayout(pageDataUrl, Boolean(pending))
        /**
         * 页脚那条像是「只有题号」的，多半是下一页那道题的头。
         *
         * **但不把它丢掉**——照样抽一遍。此前丢掉它，判错时就整条没了：
         * 页底一道开头很短的真题被当成题号扔了。现在它只影响一件事：
         * 下一页开头那段算作新题（而不是并进上一道题）。
         * 抽出来若只是个题号，由 looksLikeQuestion 滤掉，代价只是一次调用。
         */
        const trailing = items.length > 0 && items[items.length - 1]!.dangling ? items[items.length - 1]! : undefined
        const nextPending = trailing ? { label: trailing.label, preview: trailing.preview } : undefined
        const boxes = { total: items.length, withBox: items.filter((i) => i.box).length }
        if (items.length === 0) {
            return { drafts: [], mergedFirst: false, boxes, pending: nextPending, rescued: 0 }
        }

        const drafts: Draft[] = []
        let rescued = 0
        // 哪一条版面项产出了哪份草稿——补漏时要把它换掉
        const draftsByItem = new Map<number, Draft>()
        let mergedFirst = false

        /**
         * 先认领页首那块无主区域。
         *
         * 第一道题从 leadTop 才开始，说明上面那一截不属于本页任何一道题——
         * 它是上一页那道题的后半截（教师版里多半整块是【答案】【解析】）。
         * 实测第12讲 p4 有 79% 的篇幅是这种内容，版面那趟一条都没输出，
         * 上一页那道题的答案就此丢失。
         */
        const leadTop = items[0]?.box?.[1] ?? 0
        // 上一页留了个光杆题号时，页首那段是新题的题干，不是上一题的尾巴
        if (previous && !pending && leadTop >= LEAD_MIN && !items[0]?.continued) {
            const leadCrop = await cropPage(pageDataUrl, [0, 0, 1, leadTop]).catch(() => null)
            if (leadCrop) {
                try {
                    const tail = await fetchTail({ content: leadCrop, carryOver: previous.stem })
                    if (tail && (tail.answer || tail.analysis || tail.hasFigure)) {
                        // 这一块整个是解析：里面有图就是老师画的解法图，
                        // 绝不会是题干图（题干在上一页）
                        const analysisImage = tail.hasFigure
                            ? ((await cropPage(pageDataUrl, [0, 0, 1, leadTop], FIGURE_PAD).catch(
                                  () => null,
                              )) ?? previous.analysisImage)
                            : previous.analysisImage
                        drafts.push({ ...applyTail(previous, tail), analysisImage })
                        mergedFirst = true
                    }
                } catch (err) {
                    setPdfNote(`页首那段续文没读出来（${String(err)}），上一页那道题可能缺答案`)
                }
            }
        }

        for (const [i, item] of items.entries()) {
            setPdfProgress({ done: i, total: items.length, phase: 'question' })
            // 框不可用（或裁出来太小）就用整页图：效果差一点，但绝不裁坏
            const cropped = await cropPage(pageDataUrl, item.box).catch(() => null)
            /**
             * 但页脚那条光杆题号例外：它的框窄到裁不出图，退回整页必然抽到
             * 同页别的题——实测就这么抽出了一份练习8 的副本，而且一份带 LaTeX
             * 一份不带，查重都挡不住。它的正文在下一页，这里没什么可抽的。
             */
            if (!cropped && item.dangling) continue
            // 只有本页第一题才可能是上一页的续文
            /**
             * 什么时候该合并进上一道题：只有上一页那道题**确实被切开**时。
             * 上一页只留下一个题号（pendingLabel）的话，这一页开头是**新题**——
             * 合并进去就等于把新题吞了，那正是练习7、练习9 丢失的方式。
             */
            const carryFrom =
                i === 0 && item.continued && !mergedFirst && !pending ? previous : undefined
            // 上一页只留下题号时：这是**新题**，但它的开头那几个字在上一页，
            // 一并交给模型去拼（不合并进上一道题）
            // 上一页那条的文字只在像题干时才传：传一句章节标题过去，
            // 模型会被"请把它与本图的内容拼成完整题干"带偏，直接答不出题
            const carryText =
                i === 0 && pending ? carryableText(pending.preview, pending.label) : carryFrom?.stem
            try {
                const draft = await fetchQuestion({
                    content: cropped ?? pageDataUrl,
                    hasFigure: item.hasFigure,
                    ...(carryText ? { carryOver: carryText } : {}),
                })
                /**
                 * 读不出来就换一套提示词再读一次。
                 *
                 * 「这一块没读出题目」是实机上最常见的丢题方式，而且是随机的——
                 * 同一张图跑两次，一次出题一次空。单题那套提示词说"这张图是一道题"，
                 * 整页那套说"抽出全部题"，写法完全不同，所以这是真正的第二次机会，
                 * 不是把同一句话再说一遍。只在第一次失败时才跑。
                 */
                let usable = draft && looksLikeQuestion(draft, item.label) ? draft : null
                if (!usable && cropped) {
                    const retry = (await uploadOnce({ kind: 'image', content: cropped }).catch(() => []))
                        .filter((d) => looksLikeQuestion(d, item.label))
                    if (retry.length > 0) {
                        usable = retry[0]!
                        // 换个提示词反而抽出好几道，说明这一块本来就不止一道题
                        if (retry.length > 1) {
                            drafts.push(...retry.slice(1))
                            rescued += retry.length - 1
                        }
                    }
                }
                if (usable) {
                    const draft = usable
                    /**
                     * 两张图分开裁。
                     *
                     * 题干图是孩子做题时看的，解析图是老师画的解法——
                     * 教师版的解析里常另有一张（割补怎么割、阴影怎么挪），
                     * 那张图往往**就是解法本身**，做题时看见这道题就没了。
                     *
                     * 判定见服务端 classifyFigures：结构说了算，
                     * 拿不准一律算解析图（少一张题干图看得见，多给一张解法图看不见）。
                     */
                    const split = figureCropBox(item)
                    draft.figureImage =
                        (await cropPage(pageDataUrl, split.stemFigureBox, FIGURE_PAD).catch(() => null)) ??
                        undefined
                    draft.analysisImage =
                        (await cropPage(pageDataUrl, split.analysisFigureBox, FIGURE_PAD).catch(() => null)) ??
                        undefined
                    if (carryFrom) {
                        // 合并而不是替换：上一页那道题的题干图必须留住，
                        // 否则会被这一页开头的解法图顶掉（见 mergeContinued）
                        const merged = mergeContinued(carryFrom, draft)
                        drafts.push(merged)
                        draftsByItem.set(i, merged)
                        mergedFirst = true
                    } else {
                        drafts.push(draft)
                        draftsByItem.set(i, draft)
                    }
                }
            } catch (err) {
                // 一道题读不出来不该拖累同页其他题
                setPdfNote(`「${item.label || item.preview.slice(0, 10)}」识别失败（${String(err)}），继续下一题`)
            }
        }

        /**
         * 补漏：框大得离谱的那一块，再用"整页多题"的路子扫一遍。
         *
         * 切题那趟会漏报——同一份讲义连跑两次，结果并不一样。漏掉的那道
         * 不会留下空隙（snapBoxes 把前一道补到了它下面），所以从空隙上看不出来，
         * 但**框的高度会翻倍**，这个看得出来。
         *
         * 只在真的多抽出题时才采用，且入库时按题干+答案查重，
         * 所以这一步只会补题，不会造重。
         */
        for (const [i, item] of items.entries()) {
            const height = item.box ? item.box[3] - item.box[1] : 0
            // 整页只切出一条时更该查：那多半就是"版面只报了一条、其实有两道"
            if (height < OVERSIZED) continue
            const crop = await cropPage(pageDataUrl, item.box).catch(() => null)
            if (!crop) continue
            try {
                const found = await uploadOnce({ kind: 'image', content: crop })
                if (found.length > 1) {
                    setPdfNote(`「${item.label || item.preview.slice(0, 8)}」那一块里其实有 ${found.length} 道题，已补上`)
                    // 换掉那一条对应的草稿：它只抽到了其中一道
                    const at = drafts.findIndex((d) => d.stem === draftsByItem.get(i)?.stem)
                    rescued += found.length - (at >= 0 ? 1 : 0)
                    if (at >= 0) drafts.splice(at, 1, ...found)
                    else drafts.push(...found)
                }
            } catch {
                /* 补漏失败就算了，本来就是额外一道保险 */
            }
        }
        return { drafts, mergedFirst, boxes, pending: nextPending, rescued }
    }

    /**
     * PDF：先在浏览器里把每页渲染成图，再分层识别。
     *
     * 不走服务端抽文本，是因为拿真实讲义量过——文本层里没有数字：
     * 某讲义每页只有约 6 个阿拉伯字符，却有 120 处图形，抽出来的题干长这样：
     * 「一块木板上有 ⟨空⟩ 枚钉子」。带窟窿的题比抽不出来更坏。
     */
    const extractPdf = async () => {
        const buffer = await file!.arrayBuffer()
        let rendered
        try {
            // 体检与渲染在同一趟里做完：pdf.js 会转移走 buffer，
            // 开两次文档第二次就拿到已分离的空壳
            rendered = await pdfToPages(buffer, {
                onProgress: (done, total) => setPdfProgress({ done, total, phase: 'render' }),
            })
        } catch (err) {
            // 说清楚是"本机读不了这个 PDF"，而不是让人误以为是识别模型的问题
            throw new Error(
                `本机读取 PDF 失败：${err instanceof Error ? err.message : String(err)}。` +
                    '可改用「上传图片」把页面拍照或截图后上传。',
            )
        }
        const { verdict, pages } = rendered
        setPdfNote(
            verdict.trustworthy
                ? '正在逐页渲染后分层识别（先切题，再逐题读）'
                : `${verdict.reason}；已自动改为整页渲染后分层识别`,
        )
        const all: Draft[] = []
        const boxTally = { total: 0, withBox: 0 }
        // 没有题的页（封面、章节页、整页解析）攒起来最后一起说。
        // 它们不是失败——此前当成错误逐页弹红字，一本讲义能红好几条
        const emptyPages: number[] = []
        // 上一页页脚那个光杆题号（题号在页脚、正文翻到下一页）
        let pending: { label: string; preview: string } | undefined
        const reports: PageReport[] = []
        for (const [i, page] of pages.entries()) {
            setPdfProgress({ done: i, total: pages.length, phase: 'layout' })
            try {
                const outcome = await extractPageLayered(
                    page.dataUrl,
                    // 跨页题：上一页最后一道多半就是被切断的那道
                    all[all.length - 1],
                    pending,
                )
                const { drafts, mergedFirst, boxes } = outcome
                const report: PageReport = {
                    page: page.page,
                    layout: boxes.total + (outcome.pending ? 1 : 0),
                    got: drafts.length,
                    ...(outcome.pending ? { dangling: outcome.pending.label } : {}),
                    ...(outcome.rescued > 0 ? { rescued: outcome.rescued } : {}),
                }
                reports.push(report)
                setPageReports([...reports])
                pending = outcome.pending
                boxTally.total += boxes.total
                boxTally.withBox += boxes.withBox
                setBoxStat({ ...boxTally })
                // 拼好的那道题要替换掉上一页那半截，而不是两半都留着
                if (mergedFirst && all.length > 0) all.pop()
                if (drafts.length > 0) {
                    all.push(...drafts)
                    continue
                }
                // 版面说这页没题：也可能是切题这趟看走眼了，再用老路试一次
                setPdfProgress({ done: i, total: pages.length, phase: 'extract' })
                const fallback = await uploadOnce({ kind: 'image', content: page.dataUrl })
                if (fallback.length === 0) emptyPages.push(page.page)
                report.fallback = true
                report.got = fallback.length
                setPageReports([...reports])
                all.push(...fallback)
            } catch (err) {
                // 分层这条路走不通（端点不支持、模型不配合）就整页兜底，
                // 兜底也失败才算这一页丢了
                try {
                    setPdfProgress({ done: i, total: pages.length, phase: 'extract' })
                    const rescue = await uploadOnce({ kind: 'image', content: page.dataUrl })
                    all.push(...rescue)
                    reports.push({ page: page.page, layout: 0, got: rescue.length, fallback: true, note: String(err) })
                    setPdfNote(`第 ${page.page} 页分层识别不可用（${String(err)}），已按整页识别`)
                } catch (fallbackErr) {
                    reports.push({ page: page.page, layout: 0, got: 0, note: String(fallbackErr) })
                    setPdfNote(`第 ${page.page} 页识别失败（${String(fallbackErr)}），其余页继续`)
                }
                setPageReports([...reports])
            }
        }
        setPdfProgress({ done: pages.length, total: pages.length, phase: 'question' })
        if (emptyPages.length > 0) {
            setPdfNote(
                `第 ${emptyPages.join('、')} 页没有题目（封面、章节页或整页解析），已跳过`,
            )
        }
        return all
    }

    const handleExtract = async () => {
        setError(null)
        setResult(null)
        setBatchReport(null)
        setPdfNote(null)
        setPdfProgress(null)
        setBoxStat(null)
        setPageReports([])
        setExtracting(true)
        try {
            const next =
                kind === 'pdf'
                    ? await extractPdf()
                    : await uploadOnce({
                          kind,
                          content: kind === 'text' ? text : await readFileAsDataUrl(file!),
                      })
            if (next.length === 0) {
                setError('没有抽取到任何题目，请检查材料内容后重试。')
                return
            }
            setDrafts(next)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setExtracting(false)
            setPdfProgress(null)
        }
    }

    /** 批量任务完成：drafts 灌入同一草稿编辑列表，顶部展示配对报告与 warnings */
    const handleBatchDone = useCallback((outcome: BatchOutcome) => {
        setResult(null)
        setBatchReport({ pairing: outcome.pairing, warnings: outcome.warnings })
        if (outcome.drafts.length === 0) {
            setError('批量任务完成，但没有抽取到任何题目，请检查材料内容后重试。')
            return
        }
        setError(null)
        setDrafts(outcome.drafts)
    }, [])

    const updateDraft = (key: string, patch: Partial<Draft>) => {
        setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)))
    }

    const removeNode = (key: string, nodeId: string) => {
        setDrafts((ds) =>
            ds.map((d) => (d.key === key ? { ...d, nodes: d.nodes.filter((n) => n.nodeId !== nodeId) } : d))
        )
    }

    const handleConfirm = async () => {
        setError(null)
        setConfirming(true)
        try {
            const payload = {
                batchName,
                questions: drafts.map((d) => ({
                    stem: d.stem,
                    answer: d.answer,
                    answerType: d.answerType,
                    difficulty: d.difficulty,
                    level: d.level,
                    nodeIds: d.nodes.map((n) => n.nodeId),
                    ...(d.options?.length ? { options: d.options } : {}),
                    ...(d.analysis ? { analysis: d.analysis } : {}),
                    // 答案是模型自己算的这件事要跟着进库，否则入库后就查不出来了
                    ...(d.answerUnverified ? { answerUnverified: true } : {}),
                    ...(d.answerUnique === false ? { answerUnique: false } : {}),
                    // 原图入库时落盘到 media/figures（不进 git）
                    ...(d.figureImage ? { figureImage: d.figureImage } : {}),
                    // 解析图跟着进库，但只在讲解时用（做题下发时被 sanitize 挡掉）
                    ...(d.analysisImage ? { analysisImage: d.analysisImage } : {}),
                    // 配图规格原样带回；服务端入库前会再过一次门禁（前端传的一律不可信）
                    ...(d.figure ? { figure: d.figure } : {}),
                })),
            }
            const res = await fetch('/api/v1/ingest/confirm', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
            })
            if (!res.ok) {
                setError(await extractErrorMessage(res, '服务端入库接口尚未就绪。'))
                return
            }
            const body = (await res.json()) as Partial<ConfirmResult>
            setResult({
                written: body.written ?? 0,
                skippedDuplicates: body.skippedDuplicates ?? 0,
                issues: Array.isArray(body.issues) ? body.issues : [],
            })
            setDrafts([])
            setBatchReport(null)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setConfirming(false)
        }
    }

    return (
        <div className="space-y-6">
            <PageHeader title="题库录入" subtitle="上传讲义或粘贴题目，确认后进入孩子的题库" />

            {/* ── tab 切换：录入 / 抽检 ── */}
            <Segmented
                value={tab}
                onChange={setTab}
                options={
                    [
                        ['input', '录入'],
                        ['review', '抽检'],
                    ] as const
                }
            />

            {tab === 'review' ? (
                <ReviewTab />
            ) : (
                <>
                    {/* ── 输入区 ── */}
                    <section className="plate p-6 space-y-4">
                        <div className="flex items-center justify-between flex-wrap gap-3">
                            <div className="flex items-center gap-3 flex-wrap">
                                <Segmented
                                    value={mode}
                                    onChange={(m) => {
                                        setMode(m)
                                        setError(null)
                                    }}
                                    options={
                                        [
                                            ['single', '单份'],
                                            ['batch', '批量'],
                                        ] as const
                                    }
                                />

                                {mode === 'single' && (
                                    <Segmented
                                        value={kind}
                                        onChange={switchKind}
                                        options={
                                            [
                                                ['text', '粘贴文本'],
                                                ['image', '上传图片'],
                                                ['pdf', '上传 PDF'],
                                            ] as const
                                        }
                                    />
                                )}
                            </div>
                            <label className="flex items-center gap-2">
                                <span className="eyebrow">学段</span>
                                <select
                                    value={level}
                                    onChange={(e) => setLevel(e.target.value as Level)}
                                    className={`${inputCls} w-32`}
                                >
                                    {(Object.keys(LEVEL_LABELS) as Level[]).map((lv) => (
                                        <option key={lv} value={lv}>
                                            {LEVEL_LABELS[lv]}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label className="flex items-center gap-2">
                                <span className="eyebrow">批次名</span>
                                <input
                                    type="text"
                                    value={batchName}
                                    onChange={(e) => setBatchName(e.target.value)}
                                    className={`${inputCls} numeric w-40`}
                                />
                            </label>
                        </div>

                        {mode === 'batch' ? (
                            <BatchPanel batchName={batchName} onDone={handleBatchDone} />
                        ) : (
                            <>
                                {kind === 'text' ? (
                                    <textarea
                                        value={text}
                                        onChange={(e) => setText(e.target.value)}
                                        rows={8}
                                        placeholder="把题目文本粘贴到这里，一次可以粘贴多道题…"
                                        className={`${inputCls} resize-y font-mono`}
                                    />
                                ) : (
                                    <div className={dropzoneCls}>
                                        <input
                                            ref={fileInputRef}
                                            type="file"
                                            accept={kind === 'image' ? 'image/*' : 'application/pdf,.pdf'}
                                            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                                            className={fileInputCls}
                                        />
                                        <p className="mt-2 text-xs text-ink-faint">
                                            {kind === 'image'
                                                ? '支持常见图片格式（拍照的练习册/试卷）'
                                                : '扫描版与文字版都行：会在本机逐页转成图再识别，数字和插图都不会漏'}
                                            {file ? ` · 已选择：${file.name}` : ''}
                                        </p>
                                    </div>
                                )}

                                {/* PDF 要逐页渲染再逐页识别，几十页要跑一两分钟——
                                    只转个圈会让人以为卡死了，把页码报出来 */}
                                {(pdfProgress || pdfNote) && (
                                    <div className="rounded-[10px] bg-beam-wash border border-beam/20 px-4 py-2.5 space-y-1">
                                        {pdfProgress && (
                                            <p className="text-sm text-beam font-medium">
                                                {PHASE_LABEL[pdfProgress.phase]}
                                                <span className="numeric">
                                                    {' '}
                                                    {pdfProgress.done} / {pdfProgress.total}
                                                </span>
                                            </p>
                                        )}
                                        {pdfNote && <p className="text-xs text-ink-soft leading-relaxed">{pdfNote}</p>}
                                        {/* 框给不准就该换模型——把这个判断依据摆出来，
                                            而不是让人从识别结果去猜 */}
                                        {/* 逐页战报：抽少了题时，只知道"一共 8 道"查不出原因，
                                            得看每页版面报了几条、丢了几条光杆题号、补漏有没有触发 */}
                                        {pageReports.length > 0 && (
                                            <details className="text-xs text-ink-soft">
                                                <summary className="cursor-pointer text-ink-faint">
                                                    逐页明细（抽少了题时看这里）
                                                </summary>
                                                <table className="mt-2 w-full numeric text-left">
                                                    <thead className="text-ink-faint">
                                                        <tr>
                                                            <th className="pr-3 font-normal">页</th>
                                                            <th className="pr-3 font-normal">切出</th>
                                                            <th className="pr-3 font-normal">抽到</th>
                                                            <th className="font-normal">说明</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {pageReports.map((r) => (
                                                            <tr
                                                                key={r.page}
                                                                className={
                                                                    r.got === 0 ? 'text-[color:var(--color-wrong)]' : ''
                                                                }
                                                            >
                                                                <td className="pr-3">{r.page}</td>
                                                                <td className="pr-3">{r.layout}</td>
                                                                <td className="pr-3">{r.got}</td>
                                                                <td className="text-ink-faint">
                                                                    {[
                                                                        r.dangling && `页脚题号 ${r.dangling} 顺到下一页`,
                                                                        r.rescued && `补漏 +${r.rescued}`,
                                                                        r.fallback && '整页兜底',
                                                                        r.note,
                                                                    ]
                                                                        .filter(Boolean)
                                                                        .join(' · ')}
                                                                </td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </details>
                                        )}
                                        {boxStat && boxStat.total > 0 && (
                                            <p className="text-xs text-ink-faint leading-relaxed">
                                                切题定位：
                                                <span className="numeric">
                                                    {boxStat.withBox}/{boxStat.total}
                                                </span>{' '}
                                                道题给出了可用的位置框
                                                {boxStat.withBox / boxStat.total < 0.5
                                                    ? '——比例偏低，说明这个视觉模型定位不准，多数题在按整页识别；换个模型会明显更好'
                                                    : '，其余按整页识别'}
                                            </p>
                                        )}
                                    </div>
                                )}

                                <div className="flex justify-end">
                                    <Button disabled={!canExtract} onClick={() => void handleExtract()}>
                                        {extracting ? '抽题中…' : '抽题'}
                                    </Button>
                                </div>
                            </>
                        )}
                    </section>

                    {/* ── 批量配对报告 ── */}
                    {batchReport && (
                        <div className="rounded-[10px] border border-beam/20 bg-beam-wash p-4 space-y-1.5">
                            {batchReport.pairing && (
                                <p className="text-sm font-semibold text-beam">
                                    配对报告：配对 <span className="numeric">{batchReport.pairing.matched}</span> 题 ·
                                    仅教师版 <span className="numeric">{batchReport.pairing.teacherOnly}</span> 题 ·
                                    仅学生版 <span className="numeric">{batchReport.pairing.studentOnly}</span> 题
                                </p>
                            )}
                            {batchReport.warnings.length > 0 && (
                                <ul className="list-disc pl-5 text-xs text-ink-soft">
                                    {batchReport.warnings.map((w, i) => (
                                        <li key={i}>{w}</li>
                                    ))}
                                </ul>
                            )}
                            {!batchReport.pairing && batchReport.warnings.length === 0 && (
                                <p className="text-sm text-beam">批量任务完成。</p>
                            )}
                        </div>
                    )}

                    {/* ── 错误提示 ── */}
                    {error && (
                        <div className="rounded-[10px] border border-wrong/25 bg-wrong-wash p-4">
                            <p className="text-sm text-wrong">{error}</p>
                        </div>
                    )}

                    {/* ── 入库结果 ── */}
                    {result && (
                        <div className="rounded-[10px] border border-correct/25 bg-correct-wash p-4 space-y-1.5">
                            <p className="text-sm font-semibold text-[color:var(--color-correct)]">
                                入库完成：写入 <span className="numeric">{result.written}</span> 题，跳过重复{' '}
                                <span className="numeric">{result.skippedDuplicates}</span> 题
                            </p>
                            {result.issues.length > 0 && (
                                <ul className="list-disc pl-5 text-xs text-ink-soft">
                                    {result.issues.map((issue, i) => (
                                        <li key={i}>{issue}</li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}

                    {/* ── 草稿确认区（单发/批量共用） ── */}
                    {drafts.length > 0 && (
                        <section className="space-y-4">
                            <div className="flex items-center justify-between gap-3 flex-wrap">
                                <h2 className="text-section">
                                    抽取到 <span className="numeric">{drafts.length}</span> 道题 · 请核对后入库
                                </h2>
                                <Button disabled={confirming} onClick={() => void handleConfirm()}>
                                    {confirming ? '入库中…' : '确认入库'}
                                </Button>
                            </div>

                            {drafts.map((d, idx) => (
                                <div key={d.key} className="plate p-5 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <span className="eyebrow">
                                            第 <span className="numeric">{idx + 1}</span> 题
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => setDrafts((ds) => ds.filter((x) => x.key !== d.key))}
                                            className="text-xs text-ink-faint hover:text-wrong transition-colors"
                                        >
                                            删除此题
                                        </button>
                                    </div>

                                    <label className="block">
                                        <span className="eyebrow block mb-1">题干</span>
                                        <textarea
                                            value={d.stem}
                                            onChange={(e) => updateDraft(d.key, { stem: e.target.value })}
                                            rows={3}
                                            className={`${inputCls} mt-1 resize-y`}
                                        />
                                    </label>

                                    {d.options && d.options.length > 0 && (
                                        <p className="text-xs text-ink-soft">选项：{d.options.join(' / ')}</p>
                                    )}

                                    {/* 原题原图。它就是讲义上那一块，孩子做题时看的也是它，
                                        所以核对起来只有一个问题：裁得对不对 */}
                                    {d.figureImage ? (
                                        <div className="rounded-[10px] border border-rule bg-plate/40 p-3 space-y-1">
                                            <p className="eyebrow">原题配图 · 核对是否裁全</p>
                                            <img
                                                src={d.figureImage}
                                                alt="原题配图"
                                                className="max-w-full max-h-72 rounded-[6px]"
                                            />
                                        </div>
                                    ) : null}

                                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                                        <label className="block">
                                            <span className="eyebrow block mb-1">
                                                答案
                                                {/* 学生版没印答案时模型会自己算一个，而且两次未必一样。
                                                    这种数进库会让判题全反，所以在输入框上就要说清楚 */}
                                                {d.answerUnverified && (
                                                    <span className="ml-1.5 text-[color:var(--color-wrong)] normal-case">
                                                        · 模型自己解的，请核对
                                                    </span>
                                                )}
                                            </span>
                                            <input
                                                type="text"
                                                value={d.answer}
                                                onChange={(e) => updateDraft(d.key, { answer: e.target.value })}
                                                className={`${inputCls} numeric mt-1 ${
                                                    d.answerUnverified ? 'border-wrong/40' : ''
                                                }`}
                                            />
                                        </label>
                                        <label className="block">
                                            <span className="eyebrow block mb-1">答案类型</span>
                                            <select
                                                value={d.answerType}
                                                onChange={(e) =>
                                                    updateDraft(d.key, { answerType: e.target.value as AnswerType })
                                                }
                                                className={`${inputCls} mt-1`}
                                            >
                                                {(Object.keys(ANSWER_TYPE_LABELS) as AnswerType[]).map((t) => (
                                                    <option key={t} value={t}>
                                                        {ANSWER_TYPE_LABELS[t]}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>
                                        <label className="block">
                                            <span className="eyebrow block mb-1">难度 1-5</span>
                                            <select
                                                value={d.difficulty}
                                                onChange={(e) =>
                                                    updateDraft(d.key, { difficulty: Number(e.target.value) })
                                                }
                                                className={`${inputCls} numeric mt-1`}
                                            >
                                                {[1, 2, 3, 4, 5].map((n) => (
                                                    <option key={n} value={n}>
                                                        {n} · {'★'.repeat(n)}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>
                                        <label className="block">
                                            <span className="eyebrow block mb-1">学段</span>
                                            <select
                                                value={d.level}
                                                onChange={(e) => updateDraft(d.key, { level: e.target.value as Level })}
                                                className={`${inputCls} mt-1`}
                                            >
                                                {(Object.keys(LEVEL_LABELS) as Level[]).map((lv) => (
                                                    <option key={lv} value={lv}>
                                                        {LEVEL_LABELS[lv]}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>
                                    </div>

                                    <div>
                                        <span className="eyebrow block mb-1">关联知识点 · AI 建议可删除</span>
                                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                                            {d.nodes.length === 0 && (
                                                <span className="text-xs text-ink-faint">（无建议知识点）</span>
                                            )}
                                            {d.nodes.map((n) => (
                                                <span
                                                    key={n.nodeId}
                                                    className="inline-flex items-center gap-1.5 rounded-md border border-beam/20 bg-beam-wash px-2.5 py-1 text-xs text-beam"
                                                >
                                                    {n.nodeId}
                                                    {typeof n.confidence === 'number' && (
                                                        <span className="numeric opacity-70">
                                                            {Math.round(n.confidence * 100)}%
                                                        </span>
                                                    )}
                                                    <button
                                                        type="button"
                                                        onClick={() => removeNode(d.key, n.nodeId)}
                                                        aria-label={`移除 ${n.nodeId}`}
                                                        className="ml-0.5 text-ink-faint hover:text-wrong transition-colors"
                                                    >
                                                        ×
                                                    </button>
                                                </span>
                                            ))}
                                        </div>

                                        {/* 配图本身已经画在上面了，这里只说被丢掉的那些——
                                            抽检时要看得见系统替你扔了什么 */}
                                        {d.figureRejected && (
                                            <p className="mt-2 text-xs text-[color:var(--color-wrong)] leading-relaxed">
                                                配图已丢弃：{d.figureRejected}
                                            </p>
                                        )}
                                        {d.droppedSuggestions?.length ? (
                                            <p className="mt-1.5 text-xs text-ink-faint leading-relaxed">
                                                模型还提到「{d.droppedSuggestions.join('、')}」，
                                                但图谱里没有对应的知识点——这也是补大纲的线索。
                                            </p>
                                        ) : null}
                                    </div>
                                </div>
                            ))}
                        </section>
                    )}

                    {drafts.length === 0 && !result && !error && (
                        <p className="text-center text-sm text-ink-faint">
                            抽题后会在这里生成草稿列表，核对无误再「确认入库」。
                        </p>
                    )}
                </>
            )}
        </div>
    )
}
