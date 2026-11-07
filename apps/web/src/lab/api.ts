/**
 * AI 实验台的 API 直连层：类型与服务端 `apps/server/src/lab.ts` 的响应一一对应。
 *
 * 客户端**不做**任何"顺手补个默认值"的加工：模型名、温度、耗时、是不是本地，
 * 都是这一页要给人看的事实，抹平一个就少一个判断依据。
 */

const API_BASE = '/api/v1/lab'

/** 一次调用的参数覆盖：都不给就用端点默认（.env 里的模型、客户端的默认温度） */
export interface LabSideSpec {
    temperature?: number
    /** 留空/不传 = 用端点默认模型 */
    model?: string
}

export interface LabRunResult {
    reply: string
    /** 墙钟耗时（毫秒），含流式收尾 */
    ms: number
    model: string
    /** 实际下发的温度；null 表示没指定、由端点默认决定 */
    temperature: number | null
    /** 当前实例是否处在 LOCAL_ONLY 下（数据没出机器） */
    localOnly: boolean
    /** 失败原因；成功时没有这个字段 */
    error?: string
}

export interface LabCompareResult {
    prompt: string
    a: LabRunResult
    b: LabRunResult
    /** b.ms − a.ms：正数表示 B 更慢 */
    deltaMs: number
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as { error?: unknown }
    if (!res.ok) {
        // 服务端的 error 是照着"家长看得懂"写的（模型没加载、LOCAL_ONLY 拦下云端…），
        // 原样透出去比在客户端重写一遍更准确
        throw new Error(typeof data.error === 'string' ? data.error : `请求失败（HTTP ${res.status}）`)
    }
    return data as T
}

export function runLab(input: { prompt: string } & LabSideSpec): Promise<LabRunResult> {
    return postJson<LabRunResult>('/run', {
        prompt: input.prompt,
        temperature: input.temperature,
        model: input.model?.trim() || undefined,
    })
}

export function compareLab(input: {
    prompt: string
    a: LabSideSpec
    b: LabSideSpec
}): Promise<LabCompareResult> {
    const side = (s: LabSideSpec): LabSideSpec => ({
        temperature: s.temperature,
        model: s.model?.trim() || undefined,
    })
    return postJson<LabCompareResult>('/compare', {
        prompt: input.prompt,
        a: side(input.a),
        b: side(input.b),
    })
}
