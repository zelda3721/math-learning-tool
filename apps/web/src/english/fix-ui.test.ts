import { describe, expect, it, vi } from 'vitest'

import {
    NETWORK_DOWN,
    SERVICE_UNAVAILABLE,
    assessmentAnswerOutcome,
    assessmentStartError,
    bandLevel,
    canSkipPending,
    classroomResumeTarget,
    createPushToTalk,
    firstUnansweredIndex,
    listeningDone,
    listeningVerdict,
    mustUseNote,
    nextListeningIndex,
    paceToSpeed,
    requestJson,
    safeJson,
    showInconsistent,
    type RecorderLike,
    type StreamLike,
} from './uiLogic'

/** 造一个最小的 Response：只要 ok / status / text */
function fakeRes(status: number, body: string) {
    return { ok: status >= 200 && status < 300, status, text: async () => body }
}

describe('G-06 safeJson：非 JSON 不把解析异常甩给孩子', () => {
    it('网关回 HTML 错误页 → 服务暂时不可用', async () => {
        const r = await safeJson(fakeRes(502, '<html>Bad Gateway</html>'))
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.error).toBe(SERVICE_UNAVAILABLE)
    })

    it('200 但空体 / 非 JSON 也不算成功', async () => {
        expect((await safeJson(fakeRes(200, ''))).ok).toBe(false)
        expect((await safeJson(fakeRes(200, 'ok'))).ok).toBe(false)
    })

    it('错误状态优先用服务端给的那句话', async () => {
        const r = await safeJson(fakeRes(409, JSON.stringify({ error: '这一档已经做过了' })))
        expect(r).toMatchObject({ ok: false, status: 409, error: '这一档已经做过了' })
    })

    it('正常 JSON 原样交出', async () => {
        const r = await safeJson<{ a: number }>(fakeRes(200, '{"a":1}'))
        expect(r).toEqual({ ok: true, status: 200, data: { a: 1 } })
    })
})

describe('G-03 requestJson：超时与取消', () => {
    /** 永不返回、但会响应 abort 的 fetch——模拟卡死的本地模型 */
    const hangingFetch = ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })) as unknown as typeof fetch

    it('超时后回一句人话，不会一直转圈', async () => {
        vi.useFakeTimers()
        try {
            const p = requestJson('/x', {}, { timeoutMs: 60_000, timeoutMessage: 'AI 想太久了', fetchImpl: hangingFetch })
            await vi.advanceTimersByTimeAsync(60_001)
            const r = await p
            expect(r).toMatchObject({ ok: false, timedOut: true, error: 'AI 想太久了' })
        } finally {
            vi.useRealTimers()
        }
    })

    it('外部取消（卸载 / 换一篇）标成 aborted，调用方不弹错', async () => {
        const outer = new AbortController()
        const p = requestJson('/x', {}, { timeoutMs: 60_000, timeoutMessage: 't', signal: outer.signal, fetchImpl: hangingFetch })
        outer.abort()
        const r = await p
        expect(r).toMatchObject({ ok: false, aborted: true })
    })

    it('断网（fetch 直接抛）给"连不上服务"', async () => {
        const broken = (async () => {
            throw new TypeError('Failed to fetch')
        }) as unknown as typeof fetch
        const r = await requestJson('/x', {}, { timeoutMs: 1000, timeoutMessage: 't', fetchImpl: broken })
        expect(r).toMatchObject({ ok: false, error: NETWORK_DOWN })
    })

    it('正常返回时把 signal 交给 fetch（才能被掐掉）', async () => {
        let seen: AbortSignal | undefined
        const ok = (async (_u: string, init?: RequestInit) => {
            seen = init?.signal ?? undefined
            return fakeRes(200, '{"v":2}')
        }) as unknown as typeof fetch
        const r = await requestJson<{ v: number }>('/x', {}, { timeoutMs: 1000, timeoutMessage: 't', fetchImpl: ok })
        expect(r).toEqual({ ok: true, status: 200, data: { v: 2 } })
        expect(seen).toBeInstanceOf(AbortSignal)
    })
})

describe('G-04 听力：最后一题后进入完成态；答错只说再听一遍', () => {
    it('最后一题点「做完了」题号前进到 total，进入完成态（不再原地重出同一题）', () => {
        const total = 3
        const after = nextListeningIndex(2, total)
        expect(after).toBe(3)
        expect(listeningDone(after, total)).toBe(true)
        expect(listeningDone(nextListeningIndex(0, total), total)).toBe(false)
    })

    it('答错且 retry=true：不揭晓、不前进', () => {
        expect(listeningVerdict({ correct: false, retry: true })).toEqual({ kind: 'retry' })
    })

    it('第三次错才有参考答案：这时显示出来', () => {
        expect(listeningVerdict({ correct: false, retry: false, reference: 'by bus', evidence: 'He goes by bus.' })).toEqual({
            kind: 'reveal',
            reference: 'by bus',
            evidence: 'He goes by bus.',
        })
    })

    it('答对：带原文依据', () => {
        expect(listeningVerdict({ correct: true, evidence: 'x' })).toEqual({ kind: 'correct', evidence: 'x' })
    })
})

describe('写作：三档文字，不显示 x/5（C-06）', () => {
    it('1-2 还在练 / 3 基本做到 / 4-5 做得好 / null 为 —', () => {
        expect(bandLevel(1)).toBe('还在练')
        expect(bandLevel(2)).toBe('还在练')
        expect(bandLevel(3)).toBe('基本做到')
        expect(bandLevel(4)).toBe('做得好')
        expect(bandLevel(5)).toBe('做得好')
        expect(bandLevel(null)).toBe('—')
        for (const n of [1, 2, 3, 4, 5]) expect(bandLevel(n)).not.toMatch(/\/5|\d/)
    })

    it('inconsistent 只有 true 才警告；null 是"不知道"', () => {
        expect(showInconsistent(true)).toBe(true)
        expect(showInconsistent(null)).toBe(false)
        expect(showInconsistent(false)).toBe(false)
        expect(showInconsistent(undefined)).toBe(false)
    })

    it('mustUseMissing 非空才说一句', () => {
        expect(mustUseNote(['because', 'first'])).toBe('还没用上：because / first')
        expect(mustUseNote([])).toBeNull()
        expect(mustUseNote(undefined)).toBeNull()
    })
})

describe('G-05 口语：按住说话的麦克风生命周期', () => {
    function harness(opts: { deny?: boolean } = {}) {
        const trackStops: number[] = []
        let resolveStream: (s: StreamLike) => void = () => {}
        const stream: StreamLike = {
            getTracks: () => [{ stop: () => trackStops.push(1) }],
        }
        const recorders: (RecorderLike & { started: boolean; stopped: boolean })[] = []
        const events = { recording: [] as boolean[], blobs: [] as Blob[], denied: 0 }
        const ptt = createPushToTalk({
            getStream: () =>
                opts.deny
                    ? Promise.reject(new Error('NotAllowedError'))
                    : new Promise<StreamLike>((resolve) => {
                          resolveStream = resolve
                      }),
            createRecorder: () => {
                const rec = {
                    started: false,
                    stopped: false,
                    state: 'inactive',
                    mimeType: 'audio/webm',
                    ondataavailable: null as RecorderLike['ondataavailable'],
                    onstop: null as RecorderLike['onstop'],
                    start() {
                        this.started = true
                        this.state = 'recording'
                    },
                    stop() {
                        this.stopped = true
                        this.state = 'inactive'
                        this.ondataavailable?.({ data: new Blob(['abc']) } as unknown as BlobEvent)
                        this.onstop?.(new Event('stop'))
                    },
                }
                recorders.push(rec)
                return rec
            },
            onRecording: (a) => events.recording.push(a),
            onBlob: (b) => events.blobs.push(b),
            onDenied: () => events.denied++,
        })
        return { ptt, stream, resolve: () => resolveStream(stream), trackStops, recorders, events }
    }

    it('权限弹窗期间就松手：拿到流后立即 stop，不录音、不发送', async () => {
        const h = harness()
        const pressing = h.ptt.press()
        h.ptt.release() // 流还没到
        h.resolve()
        await pressing
        expect(h.trackStops.length).toBe(1)
        expect(h.recorders.length).toBe(0)
        expect(h.events.blobs.length).toBe(0)
        expect(h.ptt.phase).toBe('idle')
    })

    it('正常按住 → 松手：录到声音、送出去、释放麦克风', async () => {
        const h = harness()
        const pressing = h.ptt.press()
        h.resolve()
        await pressing
        expect(h.ptt.phase).toBe('recording')
        h.ptt.release()
        expect(h.events.blobs.length).toBe(1)
        expect(h.trackStops.length).toBe(1)
        expect(h.events.recording).toEqual([true, false])
        expect(h.ptt.phase).toBe('idle')
    })

    it('录音中切走标签页 / 卸载（cancel）：丢弃录音并释放 tracks', async () => {
        const h = harness()
        const pressing = h.ptt.press()
        h.resolve()
        await pressing
        h.ptt.cancel()
        expect(h.events.blobs.length).toBe(0)
        expect(h.trackStops.length).toBeGreaterThanOrEqual(1)
        expect(h.recorders[0]?.stopped).toBe(true)
        expect(h.ptt.phase).toBe('idle')
    })

    it('等授权时就 cancel：之后到手的流也会被还回去', async () => {
        const h = harness()
        const pressing = h.ptt.press()
        h.ptt.cancel()
        h.resolve()
        await pressing
        expect(h.trackStops.length).toBe(1)
        expect(h.recorders.length).toBe(0)
    })

    it('拒绝授权：回到空闲，提示打字', async () => {
        const h = harness({ deny: true })
        await h.ptt.press()
        expect(h.events.denied).toBe(1)
        expect(h.ptt.phase).toBe('idle')
    })

    it('语速：慢 0.8 / 正常 1.0，落在服务端 0.7–1.2 之内', () => {
        for (const p of ['slow', 'normal'] as const) {
            expect(paceToSpeed(p)).toBeGreaterThanOrEqual(0.7)
            expect(paceToSpeed(p)).toBeLessThanOrEqual(1.2)
        }
        expect(paceToSpeed('slow')).toBeLessThan(paceToSpeed('normal'))
    })
})

describe('G-06 测评：作答没记下就停在这一题', () => {
    it('失败的作答要重试，不前进', () => {
        expect(assessmentAnswerOutcome({ ok: false, status: 500 })).toBe('retry')
        expect(assessmentAnswerOutcome({ ok: false, status: 0 })).toBe('retry')
    })

    it('成功或 409（已作答过）算记下了', () => {
        expect(assessmentAnswerOutcome({ ok: true, status: 200 })).toBe('recorded')
        expect(assessmentAnswerOutcome({ ok: false, status: 409 })).toBe('recorded')
    })

    it('410（已经交卷）去取结果，不当成记下了继续答', () => {
        expect(assessmentAnswerOutcome({ ok: false, status: 410 })).toBe('finished')
    })

    it('续做从第一道没答的题开始；全答过了直接交卷', () => {
        expect(firstUnansweredIndex(['a', 'b', 'c'], ['a'])).toBe(1)
        expect(firstUnansweredIndex(['a', 'b', 'c'], ['a', 'c'])).toBe(1)
        expect(firstUnansweredIndex(['a', 'b'], ['a', 'b'])).toBeNull()
        expect(firstUnansweredIndex(['a', 'b'], undefined)).toBe(0)
    })

    it('开测评失败给人话：服务端的话优先，否则按状态码', () => {
        expect(assessmentStartError(403, null)).toContain('家长')
        expect(assessmentStartError(409, undefined)).toContain('还开不了')
        expect(assessmentStartError(409, '前测已经做过了')).toBe('前测已经做过了')
        expect(assessmentStartError(502, SERVICE_UNAVAILABLE)).toBe(SERVICE_UNAVAILABLE)
    })
})

describe('A-04 判不准时的跳过要先用过一级提示', () => {
    it('没要过提示：不给跳过', () => {
        expect(canSkipPending('pending', 0)).toBe(false)
    })
    it('要过提示：给跳过', () => {
        expect(canSkipPending('pending', 1)).toBe(true)
        expect(canSkipPending('pending', 3)).toBe(true)
    })
    it('不是 pending 不出现', () => {
        expect(canSkipPending('wrong', 2)).toBe(false)
        expect(canSkipPending(null, 2)).toBe(false)
    })
})

describe('E-06 课堂续学不越过提问拍', () => {
    it('存档在提问拍之后、题还没答：停在提问拍', () => {
        expect(classroomResumeTarget(5, 3, true, false)).toBe(3)
    })
    it('存档在提问拍之前：照常回到存档', () => {
        expect(classroomResumeTarget(2, 3, true, false)).toBe(2)
    })
    it('没有题 / 已经答过：不拦', () => {
        expect(classroomResumeTarget(5, 3, false, false)).toBe(5)
        expect(classroomResumeTarget(5, 3, true, true)).toBe(5)
    })
})
