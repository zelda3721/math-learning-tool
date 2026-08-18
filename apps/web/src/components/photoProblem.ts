/**
 * 拍照识题（问一道题 / 讲解共用）。
 *
 * 复用录题管线的分层抽取，但目标不同：录题面对整本讲义，这里面对
 * 孩子拍的**一道题**。流程仍是三步——照片切题（服务端）→ 按框裁图（本地
 * 画布）→ 单题识别（服务端）——因为服务端没有画布，裁图只能在前端做。
 *
 * 抽出来的题干一律回填到输入框让孩子过目再提交：模型读错一个数字，
 * 后面判卷、讲解全都跟着错，这一眼人工确认省不掉。
 */
import { cropPage, figureCropBox, type Box } from '../ingest/crop'
import { extractErrorMessage, readFileAsDataUrl } from '../ingest/shared'

/** 服务端 /ask/photo/layout 返回的一条（classifyFigures 已判好题干图/解析图） */
export interface PhotoLayoutItem {
    index: number
    label: string
    preview: string
    box?: Box
    hasFigure: boolean
    stemFigureBox?: Box
    analysisFigureBox?: Box
    continued?: boolean
    dangling?: boolean
    answerTop?: number
}

export interface ExtractedPhotoProblem {
    problem: string
    /** 题干配图（从照片上裁下的 data URL）；没图的题就没有 */
    figureImage?: string
    /** 整道题的照片（题干 + 图，转正后、多题时按框裁出的那一道）：图片本身就是题 */
    problemImage?: string
}

/**
 * 手机原图动辄 4000×3000、好几 MB：直接发给本地视觉模型既慢又没必要
 * （讲义页在录题管线里也就渲染到这个量级）。超过就等比缩到最长边 1600。
 */
const MAX_SIDE = 1600
const JPEG_QUALITY = 0.85

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('这张图片打不开，换一张试试（截图或 JPG/PNG 都可以）'))
        img.src = dataUrl
    })
}

/**
 * 照片 → 送识别的 data URL：统一缩尺寸、统一转 JPEG（顺带把 HEIC 之类挡在早期）。
 * 带 EXIF 方向的照片浏览器解码时会自动转正，经画布重编码后就是正的；
 * 但微信传的图 EXIF 被剥光、像素本身是横的——那种靠后面的方向判定趟。
 */
export async function photoToDataUrl(file: File): Promise<string> {
    const raw = await readFileAsDataUrl(file)
    const img = await loadImage(raw)
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
    const width = Math.max(1, Math.round(img.naturalWidth * scale))
    const height = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return raw
    // 透明底在 JPEG 里会变黑（截图常见）——先铺白
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(img, 0, 0, width, height)
    const out = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
    canvas.width = 0
    canvas.height = 0
    return out
}

/** 把图顺时针旋转 90/180/270 度（0 度原样返回）。转不动时原样返回，不拦流程。 */
export async function rotateDataUrl(dataUrl: string, cwDegrees: number): Promise<string> {
    const norm = ((Math.round(cwDegrees / 90) * 90) % 360 + 360) % 360
    if (norm === 0) return dataUrl
    const img = await loadImage(dataUrl)
    const swap = norm === 90 || norm === 270
    const canvas = document.createElement('canvas')
    canvas.width = swap ? img.naturalHeight : img.naturalWidth
    canvas.height = swap ? img.naturalWidth : img.naturalHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return dataUrl
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    // canvas 的 y 轴朝下，正角就是顺时针——与服务端「顺时针转 n 度」的约定一致
    ctx.translate(canvas.width / 2, canvas.height / 2)
    ctx.rotate((norm * Math.PI) / 180)
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2)
    const out = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
    canvas.width = 0
    canvas.height = 0
    return out
}

/**
 * 裁出来的配图太小就等比放大（短边到 MIN_FIGURE_SHORT_SIDE，最多 4 倍）。
 * 放大不添信息，但服务端的配图规格抽取、引擎的转写与像素核对都靠像素说话——
 * 一张 300px 的小图上字母都糊成一团。引擎侧也有同样的兜底，这里先做一遍省得来回。
 */
const MIN_FIGURE_SHORT_SIDE = 800
export async function upscaleDataUrl(dataUrl: string, minShortSide = MIN_FIGURE_SHORT_SIDE): Promise<string> {
    try {
        const img = await loadImage(dataUrl)
        const short = Math.min(img.naturalWidth, img.naturalHeight)
        if (short <= 0 || short >= minShortSide) return dataUrl
        const factor = Math.min(4, minShortSide / short)
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(img.naturalWidth * factor)
        canvas.height = Math.round(img.naturalHeight * factor)
        const ctx = canvas.getContext('2d')
        if (!ctx) return dataUrl
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        const out = canvas.toDataURL('image/jpeg', 0.92)
        canvas.width = 0
        canvas.height = 0
        return out
    } catch {
        return dataUrl
    }
}

const boxArea = (box?: Box): number => (box ? Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]) : 0)

/**
 * 照片里认出多道题时选哪道：**占面积最大的那道**。
 * 孩子拍的是自己不会的那道题，取景自然以它为主体；就算选错了，
 * 题干会回填到输入框里给人看，改一下就是。光杆题号（dangling）不参选。
 */
export function pickPhotoItem<T extends PhotoLayoutItem>(items: T[]): T | null {
    const candidates = items.filter((item) => !item.dangling)
    if (candidates.length === 0) return null
    const withBox = candidates.filter((item) => item.box)
    if (withBox.length === 0) return candidates[0]!
    return withBox.reduce((best, item) => (boxArea(item.box) > boxArea(best.box) ? item : best))
}

async function post(path: string, body: unknown, notReadyHint: string): Promise<Response> {
    const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(await extractErrorMessage(res, notReadyHint))
    return res
}

const NOT_READY = '拍照识题还没配置好——先把题目打字输入吧'

/**
 * 照片的裁图余量比 PDF 版面（0.8%）大得多：手持拍摄本来就歪斜松散，
 * 模型的框也更毛糙——实机上一道几何题的框顶边偏低 5%，顶点 D、E 的标签
 * 被齐齐裁掉，图对几何题就废了。照片上一题占满画面，放大余量不会蹭到邻题。
 */
const PHOTO_PAD = 0.05
const PHOTO_ITEM_PAD = { padX: PHOTO_PAD, padY: PHOTO_PAD }

/**
 * 题干配图的裁框：上/左/右放大 PHOTO_PAD 救回被模型框裁掉的顶点标签，
 * **下边绝不越过答案线**。服务端 classifyFigures 特意把题干图框钳到 answerTop
 * （实机事故：裁出的配图底部印着「【答案】92」），余量要是把这一刀又扩回去，
 * 答案就从图片面漏给孩子了——文本面守得再严也白搭。
 */
export function figurePadBox(box: Box, answerTop?: number): Box {
    const bottomLimit = typeof answerTop === 'number' ? Math.min(1, Math.max(box[3], answerTop)) : 1
    return [
        Math.max(0, box[0] - PHOTO_PAD),
        Math.max(0, box[1] - PHOTO_PAD),
        Math.min(1, box[2] + PHOTO_PAD),
        Math.min(bottomLimit, box[3] + PHOTO_PAD),
    ]
}

/** 方向判定的时限：锦上添花的一步，模型挂起时不许把整条链路拖死 */
const ORIENTATION_TIMEOUT_MS = 15_000

/**
 * 文字行的走向（纯像素、不认字）：印刷文字横排时，逐行的墨迹量呈"一行字、一行空"的
 * 强周期起伏，逐列则平缓；竖排（照片侧着）正相反。用行/列投影的相对方差之比判断。
 * 返回 'horizontal' | 'vertical' | 'unknown'（两者差不多——多半是以图为主的照片，不下结论）。
 * 这是给模型的方向判定做**校验**用的：模型说要转 90°，而像素说文字已经是横的，就不转。
 */
export function textLineAxis(gray: ArrayLike<number>, width: number, height: number): 'horizontal' | 'vertical' | 'unknown' {
    if (width < 16 || height < 16) return 'unknown'
    // 墨迹阈值：相对纸色（中位数）暗一截
    const sorted = Array.from(gray as ArrayLike<number>).sort((a, b) => a - b)
    const paper = sorted[Math.floor(sorted.length / 2)] ?? 255
    const threshold = paper - Math.max(40, paper * 0.3)
    const rows = new Float64Array(height)
    const cols = new Float64Array(width)
    let total = 0
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if ((gray[y * width + x] ?? 255) < threshold) {
                rows[y] += 1
                cols[x] += 1
                total += 1
            }
        }
    }
    if (total < width * height * 0.005) return 'unknown' // 几乎没墨迹
    const relVar = (arr: Float64Array): number => {
        let mean = 0
        for (const v of arr) mean += v
        mean /= arr.length
        if (mean <= 0) return 0
        let v2 = 0
        for (const v of arr) v2 += (v - mean) * (v - mean)
        return v2 / arr.length / (mean * mean)
    }
    const rowScore = relVar(rows)
    const colScore = relVar(cols)
    if (rowScore > colScore * 1.4) return 'horizontal'
    if (colScore > rowScore * 1.4) return 'vertical'
    return 'unknown'
}

/** 把图缩到 ~256 宽取灰度，交给 textLineAxis；画布不可用时返回 'unknown' */
async function textLineAxisOf(dataUrl: string): Promise<'horizontal' | 'vertical' | 'unknown'> {
    try {
        const img = await loadImage(dataUrl)
        const scale = 256 / Math.max(img.naturalWidth, img.naturalHeight)
        const w = Math.max(16, Math.round(img.naturalWidth * scale))
        const h = Math.max(16, Math.round(img.naturalHeight * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) return 'unknown'
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, w, h)
        ctx.drawImage(img, 0, 0, w, h)
        const { data } = ctx.getImageData(0, 0, w, h)
        const gray = new Uint8Array(w * h)
        for (let i = 0; i < w * h; i += 1) {
            gray[i] = Math.round(0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!)
        }
        canvas.width = 0
        canvas.height = 0
        return textLineAxis(gray, w, h)
    } catch {
        return 'unknown'
    }
}

/**
 * 第 0 步：问服务端「这张照片顺时针转多少度文字才正」，需要就本地转正。
 * 这一步是锦上添花——判定失败/超时/端点不支持时按原样继续，绝不拦整条链路。
 */
async function uprightPhoto(photoDataUrl: string): Promise<string> {
    try {
        const res = await fetch('/api/v1/ask/photo/orientation', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: photoDataUrl }),
            signal: AbortSignal.timeout(ORIENTATION_TIMEOUT_MS),
        })
        if (!res.ok) return photoDataUrl
        const { rotate } = (await res.json()) as { rotate?: number }
        if (!rotate) return photoDataUrl
        const norm = ((Math.round(rotate / 90) * 90) % 360 + 360) % 360
        // 像素校验：模型说要转 90/270，可文字明明已经横排——那是模型判反了，不转。
        // 实机：本地视觉模型在 0/90 之间摇摆，转错一次整条链路（版面框、裁图、转写）都是侧的
        if ((norm === 90 || norm === 270) && (await textLineAxisOf(photoDataUrl)) === 'horizontal') {
            console.warn(`[photo] 方向判定给出 ${norm}°，但像素上文字已是横排——忽略旋转`)
            return photoDataUrl
        }
        return await rotateDataUrl(photoDataUrl, rotate)
    } catch {
        return photoDataUrl
    }
}

async function layoutItems(photoDataUrl: string): Promise<PhotoLayoutItem[]> {
    const res = await post('/api/v1/ask/photo/layout', { content: photoDataUrl }, NOT_READY)
    const { items = [] } = (await res.json()) as { items?: PhotoLayoutItem[] }
    return items
}

/** 配图几何核对的时限：一次视觉转写 + 像素几何，本地模型 20~40 秒 */
const FIGURE_GROUND_TIMEOUT_MS = 90_000

/**
 * 读图一次、处处可用：引擎按像素几何核对图上标注，返回把「图中标注：…」写准了的题干。
 * 抽取模型只会猜"中间上方的三角形是 5"，像素几何才说得出"三角形 AEF 内标注 5"。
 */
async function groundFigureConditions(problem: string, figureImage: string): Promise<string> {
    try {
        const res = await fetch('/api/v1/figure/transcribe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ problem, figure_image: figureImage }),
            signal: AbortSignal.timeout(FIGURE_GROUND_TIMEOUT_MS),
        })
        if (!res.ok) return problem
        const data = (await res.json()) as { grounded?: boolean; problem_short?: string }
        if (data.grounded && data.problem_short?.trim()) return data.problem_short.trim()
        return problem
    } catch {
        return problem
    }
}

/** 整条链路：照片 → 转正 → 题干文本 + 题干配图。任何一步失败都抛可读的错。 */
export async function extractPhotoProblem(
    rawPhotoDataUrl: string,
    level?: string,
): Promise<ExtractedPhotoProblem> {
    // 侧着拍的照片先转正：版面框、题干/解析分界、裁图全都按文字水平来判
    let photoDataUrl = await uprightPhoto(rawPhotoDataUrl)
    let items = await layoutItems(photoDataUrl)
    let item = pickPhotoItem(items)
    /**
     * 方向判错的自救：模型偶尔在 90/270 之间摇摆，判反了照片就是倒的，
     * 版面自然一无所获。这时退回**未旋转的原图**再试一次——否则用户看到的
     * 是「光线好一点再拍」这种与真因无关的提示，照着做还会确定性复现。
     */
    if (!item && photoDataUrl !== rawPhotoDataUrl) {
        photoDataUrl = rawPhotoDataUrl
        items = await layoutItems(photoDataUrl)
        item = pickPhotoItem(items)
    }
    if (!item) throw new Error('照片里没认出题目——光线好一点、把整道题拍全再试试')

    /**
     * 照片里就认出一道题时**不按框裁**，整张照片直接送识别。
     * 实机教训：版面框顶边低了一行，题干开头「已知四边形ABCD中…面积为12」
     * 被齐齐裁掉，模型只好拿手写笔迹重构条件——抽出来的题缺条件还看不出毛病。
     * 单题照片没有"邻题干扰"要切，裁只有风险没有收益；多道题才按框裁（大余量）。
     */
    const multipleItems = items.filter((i) => !i.dangling).length > 1
    const cropped = multipleItems
        ? ((await cropPage(photoDataUrl, item.box, PHOTO_ITEM_PAD).catch(() => null)) ?? photoDataUrl)
        : photoDataUrl
    const questionRes = await post('/api/v1/ask/photo/question', { content: cropped, level }, NOT_READY)
    const { stem } = (await questionRes.json()) as { stem?: string | null }
    if (!stem?.trim()) throw new Error('照片里没读出题目——光线好一点、把整道题拍全再试试')

    // 只取题干图；解析图（教师版灰框里的解法图）绝不跟着题走。
    // 余量在 figurePadBox 里算好（下边被答案线封顶），这里不再叠 pad
    const { stemFigureBox } = figureCropBox(item)
    const cropped_figure = stemFigureBox
        ? ((await cropPage(photoDataUrl, figurePadBox(stemFigureBox, item.answerTop)).catch(() => null)) ??
          undefined)
        : undefined
    const figureImage = cropped_figure ? await upscaleDataUrl(cropped_figure) : undefined

    // ④ 配图几何核对：让引擎把图上写的条件按像素几何写准（"三角形AEF内标注「5」"），
    // 替换抽取模型猜的那句。这一步失败/超时就用抽取的原文，不拦路
    const problem = figureImage ? await groundFigureConditions(stem.trim(), figureImage) : stem.trim()

    return { problem, figureImage, problemImage: cropped }
}
