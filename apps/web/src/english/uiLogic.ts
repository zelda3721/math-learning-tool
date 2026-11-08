/**
 * 英语三栏（听力 / 写作 / 口语）和阶段测评共用的请求与判定小工具。
 *
 * 全部不依赖 React：这几条规矩出过事（界面锁死、解析异常甩给孩子、
 * 做完最后一题又回到同一题、松手了麦克风还开着），钉在 fix-ui.test.ts 里，
 * 改样式时不会顺手改坏。
 */

/* ────────────────────────── 请求：超时 / 取消 / 安全解析 ────────────────────────── */

/** 非 JSON（网关 502 的 HTML 页、代理报错）时给孩子看的那句话 */
export const SERVICE_UNAVAILABLE = '服务暂时不可用，稍后再试'

/** 网络断了（fetch 本身抛错，不是超时也不是取消） */
export const NETWORK_DOWN = '连不上服务——看看网络，或者稍后再试'

export type SafeJson<T> =
    | { ok: true; status: number; data: T }
    | { ok: false; status: number; data: (Partial<T> & { error?: string }) | null; error: string }

/**
 * 先读成文本再解析：早先各组件 `await res.json()` 在前、看状态在后，
 * 网关回一页 HTML 时孩子看到的是「Unexpected token '<'」。
 *
 * 失败时文案优先用服务端给的 `error`——「HTTP 409」对孩子等于什么都没说。
 */
export async function safeJson<T>(res: Pick<Response, 'ok' | 'status' | 'text'>): Promise<SafeJson<T>> {
    let data: unknown = null
    let parsed = false
    try {
        const text = await res.text()
        data = text ? JSON.parse(text) : null
        parsed = text.length > 0
    } catch {
        parsed = false
    }
    if (!parsed || data === null || typeof data !== 'object') {
        return { ok: false, status: res.status, data: null, error: SERVICE_UNAVAILABLE }
    }
    const body = data as Partial<T> & { error?: string }
    if (!res.ok) {
        const msg = typeof body.error === 'string' && body.error.trim() ? body.error : SERVICE_UNAVAILABLE
        return { ok: false, status: res.status, data: body, error: msg }
    }
    return { ok: true, status: res.status, data: data as T }
}

export interface RequestOptions {
    /** 超过这么久还没回来就放弃：本地模型慢时不能让界面一直转圈 */
    timeoutMs: number
    /** 超时时给孩子看的那句话（每个入口说法不同：写作说"AI 想太久"，听力说"语音合成太久"） */
    timeoutMessage: string
    /** 外部取消（组件卸载 / 换一篇）：被取消的请求结果直接丢掉，不弹错 */
    signal?: AbortSignal
    /** 测试注入用 */
    fetchImpl?: typeof fetch
}

export type RequestResult<T> =
    | { ok: true; status: number; data: T }
    | { ok: false; status: number; data: (Partial<T> & { error?: string }) | null; error: string; aborted?: boolean; timedOut?: boolean }

/**
 * 带超时与取消的 JSON 请求。
 *
 * - 超时：自己的 AbortController 掐掉，回 `timedOut`，文案用调用方给的人话；
 * - 外部取消：回 `aborted`，调用方应当**什么都不显示**（人已经走了）；
 * - 其他一律收成 `{ ok:false, error }`，从不往外抛——组件里不用再套 try/catch。
 */
export async function requestJson<T>(url: string, init: RequestInit, opts: RequestOptions): Promise<RequestResult<T>> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
    }, opts.timeoutMs)
    const onOuterAbort = () => controller.abort()
    if (opts.signal) {
        if (opts.signal.aborted) controller.abort()
        else opts.signal.addEventListener('abort', onOuterAbort, { once: true })
    }
    try {
        const res = await (opts.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal })
        return await safeJson<T>(res)
    } catch {
        if (timedOut) return { ok: false, status: 0, data: null, error: opts.timeoutMessage, timedOut: true }
        if (opts.signal?.aborted) return { ok: false, status: 0, data: null, error: '', aborted: true }
        return { ok: false, status: 0, data: null, error: NETWORK_DOWN }
    } finally {
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onOuterAbort)
    }
}

/** 各入口的超时：写作要模型评两次最慢，口语一轮要转写 + 回话 + 合成，听力首次要合成整篇 */
export const TIMEOUTS = {
    writing: 60_000,
    speaking: 30_000,
    listeningOpen: 60_000,
    listeningAnswer: 30_000,
    list: 20_000,
    assessment: 20_000,
} as const

/* ────────────────────────── 听力 ────────────────────────── */

export interface ListeningAnswerResponse {
    correct: boolean
    /** 服务端：答错且还没到第三次时为 true——只说"再听一遍"，不给答案 */
    retry?: boolean
    evidence?: string
    reference?: string
}

export type ListeningVerdict =
    | { kind: 'correct'; evidence: string }
    /** 还可以再答：不揭晓、不前进，输入框保持可写 */
    | { kind: 'retry' }
    /** 第三次还错：服务端才给参考答案，这时才显示出来，并允许去下一题 */
    | { kind: 'reveal'; reference: string | null; evidence: string }

export function listeningVerdict(data: ListeningAnswerResponse): ListeningVerdict {
    if (data.correct) return { kind: 'correct', evidence: data.evidence ?? '' }
    // 新服务端：答错且 retry=true——只说"再听一遍"，不前进、不揭晓
    if (data.retry === true) return { kind: 'retry' }
    // 第三次错（或旧服务端没有 retry 字段）：给了参考答案才显示；没给也要能往下走，不能把孩子困在这题
    return { kind: 'reveal', reference: data.reference ?? null, evidence: data.evidence ?? '' }
}

/**
 * 「下一题 / 做完了」之后的题号。
 *
 * 早先最后一题点「做完了」时题号原地不动、只清空了作答——同一题又出现了一遍，
 * 永远到不了完成态。题号一律 +1，到 total 即完成（`listeningDone`）。
 */
export function nextListeningIndex(index: number, total: number): number {
    return Math.min(index + 1, Math.max(0, total))
}

export function listeningDone(index: number, total: number): boolean {
    return index >= total
}

/* ────────────────────────── 写作 ────────────────────────── */

/**
 * 量规分数 → 三档文字。
 *
 * 界面上写着"不打分"，再在下面摆一个 3/5 就自相矛盾（C-06）。
 * 孩子要知道的是"这一维我在哪一档"，不是一个数字；null（模型这一维没评出来）显示"—"。
 */
export function bandLevel(score: number | null | undefined): string {
    if (score === null || score === undefined || !Number.isFinite(score)) return '—'
    if (score >= 4) return '做得好'
    if (score >= 3) return '基本做到'
    return '还在练'
}

/** 两次评分不一致的警告：只有服务端明确说 true 才显示；null 是"不知道"，不吓人 */
export function showInconsistent(value: boolean | null | undefined): boolean {
    return value === true
}

/** 要求用上的词还差哪些：空就不说话 */
export function mustUseNote(missing: string[] | null | undefined): string | null {
    const list = (missing ?? []).map((w) => w.trim()).filter(Boolean)
    return list.length ? `还没用上：${list.join(' / ')}` : null
}

/* ────────────────────────── 口语：语速 ────────────────────────── */

export type SpeakingPace = 'slow' | 'normal'

/** 语速档位 → 服务端的 speed（服务端接受 0.7–1.2） */
export function paceToSpeed(pace: SpeakingPace): number {
    return pace === 'slow' ? 0.8 : 1.0
}

/* ────────────────────────── 口语：按住说话的麦克风生命周期 ────────────────────────── */

export interface TrackLike {
    stop(): void
}
export interface StreamLike {
    getTracks(): TrackLike[]
}
export interface RecorderLike {
    start(): void
    stop(): void
    readonly state: string
    readonly mimeType: string
    // 参数类型跟 DOM 的 BlobEvent 对齐，真 MediaRecorder 才能直接当 RecorderLike 用
    ondataavailable: ((e: BlobEvent) => void) | null
    onstop: ((e: Event) => void) | null
}

export interface PushToTalkDeps {
    getStream: () => Promise<StreamLike>
    createRecorder: (stream: StreamLike) => RecorderLike
    /** 录音中 / 没在录：界面据此切按钮文字 */
    onRecording: (active: boolean) => void
    /** 正常松手录到的声音 */
    onBlob: (blob: Blob) => void
    /** 拿不到麦克风（拒绝授权、没有设备） */
    onDenied: () => void
}

export interface PushToTalk {
    press(): Promise<void>
    release(): void
    /** 丢弃：切走标签页 / 组件卸载 / 结束对话。停录、释放麦克风，不发送 */
    cancel(): void
    readonly phase: 'idle' | 'acquiring' | 'recording'
}

/**
 * 按住说话的生命周期。早先的两个洞：
 *
 * 1. **授权弹窗竞态**：第一次按下会弹权限框，孩子早松手了，`getUserMedia` 才 resolve——
 *    松手那一下 `recorderRef` 还是空的被忽略，于是录音开起来就再没人关，麦克风常亮；
 * 2. **切走不收口**：录着音切到别的标签页 / 离开这一栏，tracks 没 stop，指示灯一直亮。
 *
 * 这里把"松手"记成状态：流到手时发现已经松手（或已取消），立刻 stop 掉所有 track，什么都不发。
 */
export function createPushToTalk(deps: PushToTalkDeps): PushToTalk {
    let phase: 'idle' | 'acquiring' | 'recording' = 'idle'
    /** 每次按下 +1；取消也 +1，让还在路上的那次 getUserMedia 认出自己过期了 */
    let generation = 0
    let releasedEarly = false
    let discard = false
    let stream: StreamLike | null = null
    let recorder: RecorderLike | null = null

    const stopTracks = (s: StreamLike | null) => {
        s?.getTracks().forEach((t) => {
            try {
                t.stop()
            } catch {
                /* 已经停了 */
            }
        })
    }

    return {
        get phase() {
            return phase
        },
        async press() {
            if (phase !== 'idle') return
            phase = 'acquiring'
            releasedEarly = false
            discard = false
            const mine = ++generation
            let got: StreamLike
            try {
                got = await deps.getStream()
            } catch {
                if (mine === generation) {
                    phase = 'idle'
                    deps.onDenied()
                }
                return
            }
            // 弹窗期间已经松手 / 已取消：拿到的流立刻还回去
            if (mine !== generation || releasedEarly) {
                stopTracks(got)
                if (mine === generation) phase = 'idle'
                return
            }
            stream = got
            const rec = deps.createRecorder(got)
            recorder = rec
            const chunks: Blob[] = []
            rec.ondataavailable = (e) => {
                if (e.data.size > 0) chunks.push(e.data)
            }
            rec.onstop = () => {
                stopTracks(got)
                if (stream === got) stream = null
                if (recorder === rec) recorder = null
                phase = 'idle'
                deps.onRecording(false)
                if (discard) return
                const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
                if (blob.size > 0) deps.onBlob(blob)
            }
            rec.start()
            phase = 'recording'
            deps.onRecording(true)
        },
        release() {
            if (phase === 'acquiring') {
                releasedEarly = true
                return
            }
            if (phase === 'recording' && recorder && recorder.state !== 'inactive') recorder.stop()
        },
        cancel() {
            if (phase === 'acquiring') {
                generation++
                phase = 'idle'
                return
            }
            if (phase === 'recording') {
                discard = true
                const s = stream
                if (recorder && recorder.state !== 'inactive') recorder.stop()
                // onstop 是异步派发的：麦克风不等它，先关掉
                stopTracks(s)
            }
        },
    }
}

/* ────────────────────────── 阶段测评 ────────────────────────── */

/**
 * 作答请求的结果怎么处理。
 *
 * 早先不看返回就前进：一次失败的作答悄悄从分母里消失，孩子以为交了。
 * - 2xx：记下了，往下走；
 * - 409：服务端说这题已经作答过（多半是上次请求其实到了、只是回包丢了）——也算记下了；
 * - 410：这份测评已经交卷了（别的标签页交的）——不再作答，直接去取结果；
 * - 其他：停在这一题，提示重试。
 */
export function assessmentAnswerOutcome(res: { ok: boolean; status: number }): 'recorded' | 'finished' | 'retry' {
    if (res.ok || res.status === 409) return 'recorded'
    if (res.status === 410) return 'finished'
    return 'retry'
}

/** 续做一份没交卷的测评：从第一道还没答的题接着做；全答过了返回 null（直接交卷） */
export function firstUnansweredIndex(questionIds: string[], answeredIds: string[] | undefined): number | null {
    const done = new Set(answeredIds ?? [])
    const i = questionIds.findIndex((id) => !done.has(id))
    return i === -1 ? null : i
}

/** 开测评失败时的人话：服务端给了话就用它的，没给按状态码兜底 */
export function assessmentStartError(status: number, serverMessage?: string | null): string {
    if (serverMessage && serverMessage.trim() && serverMessage !== SERVICE_UNAVAILABLE) return serverMessage
    if (status === 403) return '测评是给孩子做的，家长账号这里开不了'
    if (status === 409) return '这一档现在还开不了：可能还没到时间，或者已经做过了'
    if (status === 0) return serverMessage || SERVICE_UNAVAILABLE
    return serverMessage || '这一档测评现在开不了'
}

/* ────────────────────────── 课堂：断点续学 ────────────────────────── */

/**
 * 「接着学」要快进到哪一拍（E-06）。
 *
 * 续学是连发 beat-finished 快进的，状态机不会在提问拍上拦——早先存档停在提问拍之后
 * （比如 generate 课换了拍数、或上次放弃过）时，一路就越过了提问拍，这节课等于没提问。
 * 进度存档里只有拍号、不记"答没答过"，所以只要这节课有题、提问拍这次还没答过，
 * 快进最多到提问拍为止。
 */
export function classroomResumeTarget(
    saved: number,
    pauseBeatIndex: number,
    hasQuestion: boolean,
    pauseSettled: boolean,
): number {
    const target = Math.max(0, Math.floor(saved))
    if (!hasQuestion || pauseSettled || pauseBeatIndex < 0) return target
    return Math.min(target, pauseBeatIndex)
}

/* ────────────────────────── 练习：判不准时的跳过 ────────────────────────── */

/**
 * 判不准（pending）时「先跳过这题」什么时候出现（A-04）。
 *
 * 判不准本身不费力气——随便写点模型拿不准的话就能得到 pending；
 * 再配一个立即可点的跳过，就成了比认真答错还划算的跳题捷径。
 * 至少看过一级提示（真想过了）才给这条退路。
 */
export function canSkipPending(feedbackKind: string | null | undefined, hintLevel: number): boolean {
    return feedbackKind === 'pending' && hintLevel >= 1
}
