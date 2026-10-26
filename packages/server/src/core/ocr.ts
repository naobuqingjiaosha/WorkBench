/**
 * OCR —— 扫描件与照片的文字识别
 *
 * 引擎：tesseract.js（纯 WASM，不需要原生编译、不需要装 Tesseract 程序）
 * 语言包：首次使用时下载一次到 data/runtime/tessdata，之后完全离线可用
 *
 * 设计要点：
 *   1. 单个 worker 串行处理，避免同时吃满 CPU；服务器只有一个用户，够用
 *   2. worker 常驻，避免每张图都重新加载语言模型（加载一次约 2-5 秒）
 *   3. 只对图片和扫描件 PDF 生效；能从 docx/xlsx 抽出文字的走文本抽取，不走 OCR
 */
import * as zlib from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNTIME_ROOT, getSetting } from './config.ts';
import { extname } from 'node:path';

export const TESSDATA_DIR = process.env.WORKBENCH_TESSDATA_DIR || join(RUNTIME_ROOT, 'tessdata');

/**
 * 语言包下载源（按顺序尝试）。
 * 有的源提供 .gz 压缩包，有的提供未压缩文件——靠后缀判断是否需要解压。
 * 体积参考：chi_sim 约 2.5MB(gz) / 12MB(fast) / 40MB(best)。
 */
const TESSDATA_SOURCES = [
  'https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0/{lang}.traineddata.gz',
  'https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0/{lang}.traineddata.gz',
  'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/{lang}.traineddata',
  'https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@main/{lang}.traineddata',
];

export interface LangStatus {
  lang: string;
  ready: boolean;
  bytes: number;
  source?: string;
  error?: string;
}

function langFile(lang: string): string {
  return join(TESSDATA_DIR, `${lang}.traineddata`);
}

export function langStatus(lang: string): LangStatus {
  const f = langFile(lang);
  if (!existsSync(f)) return { lang, ready: false, bytes: 0 };
  return { lang, ready: true, bytes: statSync(f).size };
}

export function listLangStatus(langs: string[]): LangStatus[] {
  return langs.map(langStatus);
}

/**
 * 确保语言包就绪：没有就下载。
 * 下载的是 .traineddata.gz，落盘时解开成 .traineddata（tesseract.js 用 gzip:false 读）。
 */
export async function ensureLang(lang: string, onProgress?: (msg: string, pct: number) => void): Promise<LangStatus> {
  mkdirSync(TESSDATA_DIR, { recursive: true });
  const target = langFile(lang);
  if (existsSync(target) && statSync(target).size > 1000) {
    return { lang, ready: true, bytes: statSync(target).size };
  }

  let lastError = '';
  for (const tpl of TESSDATA_SOURCES) {
    const url = tpl.replace('{lang}', lang);
    const gz = url.endsWith('.gz');
    try {
      onProgress?.(`正在下载 ${lang} 语言包`, 0);
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) {
        lastError = `${url} → HTTP ${res.status}`;
        continue;
      }
      const raw = Buffer.from(await res.arrayBuffer());
      if (raw.length < 1000) {
        lastError = `${url} → 内容过小（${raw.length} 字节）`;
        continue;
      }
      const data = gz ? gunzip(raw) : raw;
      if (data.length < 1000) {
        lastError = `${url} → 解压后异常（${data.length} 字节）`;
        continue;
      }
      const tmp = `${target}.part`;
      writeFileSync(tmp, data);
      renameSync(tmp, target);
      onProgress?.(`${lang} 语言包已就绪`, 1);
      return { lang, ready: true, bytes: data.length, source: url };
    } catch (e) {
      lastError = `${url} → ${(e as Error).message}`;
      try {
        rmSync(`${target}.part`, { force: true });
      } catch {
        /* 忽略 */
      }
    }
  }
  return {
    lang,
    ready: false,
    bytes: 0,
    error: `语言包下载失败。已尝试 ${TESSDATA_SOURCES.length} 个源。最后错误：${lastError}。\n可以手动下载 ${lang}.traineddata 放到：${TESSDATA_DIR}`,
  };
}

function gunzip(buf: Buffer): Buffer {
  // Node 24 内置 zlib
  // eslint-disable-next-line @typescript-eslint/no-require-imports

  return zlib.gunzipSync(buf);
}

/* ------------------------------ worker 管理 ------------------------------ */

interface WorkerLike {
  recognize: (img: string, opts?: Record<string, unknown>) => Promise<{ data: { text: string; confidence: number; blocks?: unknown } }>;
  terminate: () => Promise<unknown>;
}

let worker: WorkerLike | null = null;
let workerLangs = '';
let workerLoading: Promise<WorkerLike> | null = null;

export function ocrEnabled(): boolean {
  return Boolean(getSetting('ocr.enabled', false));
}

/** 解析语言设置："chi_sim+eng" → ['chi_sim','eng'] */
export function ocrLangs(): string[] {
  const raw = String(getSetting('ocr.lang', 'chi_sim+eng'));
  const langs = raw
    .split(/[+,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return langs.length ? langs : ['chi_sim'];
}

async function getWorker(onProgress?: (msg: string, pct: number) => void): Promise<WorkerLike> {
  const langs = ocrLangs();
  const key = langs.join('+');
  if (worker && workerLangs === key) return worker;
  if (workerLoading && workerLangs === key) return workerLoading;

  if (worker) {
    try {
      await worker.terminate();
    } catch {
      /* 忽略 */
    }
    worker = null;
  }

  workerLangs = key;
  workerLoading = (async () => {
    /**
     * 建 worker 的每一步（下语言包 / 动态 import / createWorker）都在这里兜住。
     *
     * 其中 `errorHandler` 是**这次修复的关键**：不传它的时候，tesseract 在
     * `createWorker.js` 的 worker 消息回调里走的是
     *   `if (errorHandler) errorHandler(data); else throw Error(data);`
     * —— 也就是在**事件回调里同步 throw**。那不是在 `await w.recognize()` 上兑现的拒绝，
     * 任何 try/catch 都包不住，直接变成主线程的未捕获异常：一张坏图 = 整个服务退出
     * （验收问题 A 的真正机制）。传了它，tesseract 就把原因交给我们的回调，
     * 同一次失败会**同时**体现在 recognize 的 reject 上，于是可以被普通 try/catch 接住。
     */
    let engineError = '';
    try {
      for (const l of langs) {
        const st = await ensureLang(l, onProgress);
        if (!st.ready) throw new Error(st.error ?? `${l} 语言包不可用`);
      }
      const tesseract = await import('tesseract.js');
      const created = (await tesseract.createWorker(langs, 1, {
        langPath: TESSDATA_DIR.split('\\').join('/'),
        cachePath: TESSDATA_DIR.split('\\').join('/'),
        gzip: false,
        errorHandler: (m: unknown) => {
          engineError = summarizeOcrError(m);
        },
        logger: (m: { status?: string; progress?: number }) => {
          // 进度回调是在 tesseract 的消息回调里同步跑的：它抛出去同样没人接，
          // 所以这里自己再兜一层，回调里的意外不能反过来打死服务。
          try {
            if (m.status && typeof m.progress === 'number') onProgress?.(m.status, m.progress);
          } catch {
            /* 进度回调出错不影响识别 */
          }
        },
      })) as unknown as WorkerLike;
      worker = created;
      return created;
    } catch (e) {
      // 失败就别把半成品状态留着：workerLangs 清掉，下次调用会重新建一个
      worker = null;
      workerLangs = '';
      const raw = summarizeOcrError(e);
      throw new Error(engineError && !raw.includes(engineError) ? `${raw}（引擎：${engineError}）` : raw);
    }
  })();

  try {
    return await workerLoading;
  } finally {
    workerLoading = null;
  }
}

/**
 * 丢掉当前 worker：终止它并清空缓存，下次 `getWorker()` 会重建一个。
 *
 * 识别失败之后必须这么做：坏图可能把引擎的内部状态搞坏，甚至把 worker 线程弄死，
 * 这时候常驻的那个 worker 就是个"坏掉的常驻对象"——接着用它，一个坏文件的账会算到
 * 后面所有好文件头上（全部识别失败），队列也再没有新任务能成功。
 * 终止本身也可能挂住（线程都死了），所以套一个 3 秒的赛跑，超时就不等了。
 */
async function discardWorker(): Promise<void> {
  const w = worker;
  worker = null;
  workerLangs = '';
  workerLoading = null;
  if (!w) return;
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => w.terminate())
        .catch(() => undefined),
      new Promise((resolve) => {
        const t = setTimeout(resolve, 3000);
        t.unref?.();
      }),
    ]);
  } catch {
    /* 忽略：worker 已经死了也无所谓 */
  }
}

export async function terminateOcr(): Promise<void> {
  await discardWorker();
}

/* --------------------------- 识别前的图片体检 --------------------------- */

/**
 * 把任意异常压成一句能给人看的话。
 *
 * tesseract 拒绝任务时回传的是**字符串**（`res.reject(err.toString())`），
 * 不是 Error；数据库层抛的是 Error；还有可能抛 object。统一在这里收拾干净，
 * 免得 `ocr_item.ocr_error` 里落一个 "[object Object]"。
 */
export function summarizeOcrError(e: unknown): string {
  let s: string;
  if (e instanceof Error) s = e.message || e.name || '未知错误';
  else if (typeof e === 'string') s = e;
  else {
    try {
      s = JSON.stringify(e) ?? String(e);
    } catch {
      s = String(e);
    }
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 200 ? `${s.slice(0, 200)}…` : s || '未知错误';
}

/** 超过这个体积就不做深度校验（只保底看文件头），免得为了校验把大图整个读进内存 */
const MAX_DEEP_VALIDATE_BYTES = 64 * 1024 * 1024;
/** IDAT 解开后的上限：超过就说明"验不动"，不据此判它是坏图 */
const MAX_INFLATE_BYTES = 512 * 1024 * 1024;

/**
 * 真正解码校验一遍图片，返回**可读的损坏原因**；没问题返回 null。
 *
 * 为什么要有这一层：`store.ts` 的 `looksLikeImage()` 只看**文件头**，
 * 于是"magic bytes 合法、里面 zlib 数据坏掉"的 PNG 能顺利过闸，
 * 一路走到 tesseract 里才炸（验收问题 A：一张坏图把整个服务打死）。
 * 在这里提前拦下来，它就只是一条**可读的失败原因**（OCR 侧标 failed），
 * 而不是让识别引擎去踩雷。下面 recognize 那层兜底依旧保留 —— 这两层是互补的。
 *
 * 判据刻意保守，**只对确凿的损坏报错**：
 *   · PNG：走完数据块结构 + 把所有 IDAT 拼起来交给内置 zlib 解一次；
 *   · JPEG：走完段结构，必须有 SOF、能找到 EOI；
 *   · 其它格式：只认文件头（由 store.ts 的 looksLikeImage 负责），这里不判，
 *     宁可让引擎自己失败（那条路已经兜住了），也不能把正常图片误判成坏的。
 * 验不动的（文件太大、IDAT 解出来超过上限、结构古怪到解析不动）一律返回 null 放行。
 */
export function imageDecodeError(absPath: string, fileName?: string): string | null {
  const ext = extname(fileName ?? absPath).toLowerCase();
  if (ext !== '.png' && ext !== '.jpg' && ext !== '.jpeg') return null;
  let buf: Buffer;
  try {
    const size = statSync(absPath).size;
    if (size <= 0) return '文件是空的（0 字节）';
    if (size > MAX_DEEP_VALIDATE_BYTES) return null;
    buf = readFileSync(absPath);
  } catch (e) {
    return `文件读不了：${summarizeOcrError(e)}`;
  }
  try {
    return ext === '.png' ? pngProblem(buf) : jpegProblem(buf);
  } catch (e) {
    // 解析代码自己出的错（而不是图片坏）不能用来定罪，放行交给引擎
    console.error(`[OCR] 图片体检自身出错，跳过校验：${summarizeOcrError(e)}`);
    return null;
  }
}

/** PNG 结构 + IDAT 真实解压校验 */
function pngProblem(buf: Buffer): string | null {
  if (buf.length < 33 || buf.subarray(0, 8).toString('latin1') !== '\x89PNG\r\n\x1a\n') return 'PNG 文件头不完整或不是 PNG';
  const idat: Buffer[] = [];
  let pos = 8;
  let sawIHDR = false;
  let sawIEND = false;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('latin1');
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (len > 0x7fffffff || dataEnd + 4 > buf.length) {
      return `PNG 数据块「${type}」被截断（声明 ${len} 字节，实际只剩 ${Math.max(0, buf.length - dataStart - 4)} 字节）`;
    }
    if (type === 'IHDR') {
      sawIHDR = true;
      if (len !== 13) return `PNG 的 IHDR 长度非法（${len}，应为 13）`;
      const w = buf.readUInt32BE(dataStart);
      const h = buf.readUInt32BE(dataStart + 4);
      if (!w || !h) return `PNG 声明的尺寸不合法（${w}×${h}）`;
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      sawIEND = true;
      break;
    }
    pos = dataEnd + 4;
  }
  if (!sawIHDR) return 'PNG 缺少 IHDR 数据块';
  if (!idat.length) return 'PNG 缺少 IDAT 图像数据块';
  if (!sawIEND) return 'PNG 没有正常结束（缺少 IEND 数据块，文件被截断）';
  try {
    // IDAT 可能被切成多块，拼起来才是**一个** zlib 流（PNG 规范如此）
    zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: MAX_INFLATE_BYTES });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') return null; // 验不动，放行
    return `PNG 图像数据（IDAT）解压失败：${summarizeOcrError(e)}`;
  }
  return null;
}

/** JPEG 段结构校验（找得到 SOF、也找得到 EOI 就算完整） */
function jpegProblem(buf: Buffer): string | null {
  if (buf.length < 4) return `JPEG 文件太短（${buf.length} 字节）`;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return 'JPEG 开头不是 SOI 标记（FFD8）';
  let pos = 2;
  let sawSOF = false;
  while (pos + 1 < buf.length) {
    if (buf[pos] !== 0xff) break; // 进入熵编码数据段，不再按标记走
    const marker = buf[pos + 1] ?? -1;
    if (marker === 0xd9) break; // EOI
    if (marker === 0xff || marker === 0x00) {
      pos += 1; // 填充字节 / 数据里的 FF00，跳过继续找
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2; // 无长度字段的标记
      continue;
    }
    if (pos + 3 >= buf.length) return 'JPEG 在段长度字段处被截断';
    const len = buf.readUInt16BE(pos + 2);
    if (len < 2) return `JPEG 段长度非法（${len}）`;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) sawSOF = true;
    if (marker === 0xda) break; // SOS：后面是压缩数据
    pos += 2 + len;
    if (pos > buf.length) return 'JPEG 段数据被截断';
  }
  if (!sawSOF) return 'JPEG 缺少 SOF 图像头（文件被截断或不是完整 JPEG）';
  let sawEOI = false;
  for (let i = buf.length - 2; i >= 2; i -= 1) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd9) {
      sawEOI = true;
      break;
    }
  }
  if (!sawEOI) return 'JPEG 缺少 EOI 结束标记（文件被截断）';
  return null;
}

/* ------------------------------ 识别入口 ------------------------------ */

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.pbm', '.pnm']);

export function isOcrCandidate(file: string): boolean {
  const ext = extname(file).toLowerCase();
  return IMAGE_EXT.has(ext) || ext === '.pdf';
}

export interface OcrResult {
  ok: boolean;
  text: string;
  confidence: number;
  lang: string;
  ms: number;
  error?: string;
}

/**
 * 单次识别的超时上限。默认 3 分钟：正常 A4 扫描件几十秒内结束，
 * 而 worker 线程被打死的情况下 `recognize()` 返回的 Promise **永远不会兑现**，
 * 没有这个上限的话处理队列会卡在这一条上（`processing` 一直为 true），
 * 后面排队的文件一个都轮不到 —— 那就等于"一个坏文件停掉整个队列"。
 */
const RECOGNIZE_TIMEOUT_MS = Number(process.env.WORKBENCH_OCR_TIMEOUT_MS ?? 0) || 180_000;

/** 给 Promise 套一个超时（超时后原本的 Promise 迟到的 reject 会被 race 吞掉，不会变成未处理拒绝） */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}（超过 ${Math.round(ms / 1000)} 秒没返回）`)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 对单个文件做 OCR */
export async function ocrFile(absPath: string, onProgress?: (msg: string, pct: number) => void): Promise<OcrResult> {
  const started = Date.now();
  const langs = ocrLangs();
  if (!existsSync(absPath)) {
    return { ok: false, text: '', confidence: 0, lang: langs.join('+'), ms: 0, error: `文件不存在：${absPath}` };
  }
  if (!isOcrCandidate(absPath)) {
    return { ok: false, text: '', confidence: 0, lang: langs.join('+'), ms: 0, error: `该格式不支持 OCR：${extname(absPath)}` };
  }
  /**
   * 先真正解码校验一遍：坏图在这一步就变成一条可读原因，不用送进引擎里踩雷。
   * 这是问题 A 的第一道防线（第二道是下面 recognize 的兜底 + index.ts 的 uncaughtException）。
   */
  const decodeProblem = imageDecodeError(absPath);
  if (decodeProblem) {
    return {
      ok: false,
      text: '',
      confidence: 0,
      lang: langs.join('+'),
      ms: Date.now() - started,
      error: `图片损坏，无法识别（${decodeProblem}）`,
    };
  }
  try {
    const w = await getWorker(onProgress);
    const r = await withTimeout(w.recognize(absPath), RECOGNIZE_TIMEOUT_MS, '识别超时');
    const text = cleanOcrText(r.data.text ?? '');
    return { ok: true, text, confidence: Math.round(r.data.confidence ?? 0), lang: langs.join('+'), ms: Date.now() - started };
  } catch (e) {
    /**
     * 兜底：识别失败的**任何**原因都不许冒出去。
     * 失败后顺手把这个 worker 丢掉（下次重建），原因见 discardWorker 的注释。
     * 丢掉 worker 本身也不能再抛：它失败就算了，反正下次会重建一个。
     */
    try {
      await discardWorker();
    } catch {
      /* 忽略 */
    }
    const raw = summarizeOcrError(e);
    // 引擎的报错多半就是"这张图读不进来"（Invalid image / PNG / zlib / 格式…），
    // 那就把原因说成用户能懂的那句；其余情况照实说，别硬安在图片头上。
    const looksLikeImageProblem = /image|png|jpe?g|gif|bmp|webp|tiff|decode|invalid|corrupt|zlib|ihdr|format|图片|格式/i.test(raw);
    return {
      ok: false,
      text: '',
      confidence: 0,
      lang: langs.join('+'),
      ms: Date.now() - started,
      error: looksLikeImageProblem ? `图片损坏，无法识别（${raw}）` : `识别失败（${raw}）`,
    };
  }
}

/**
 * 清洗 OCR 结果：合并被误断的行、去掉纯噪声行。
 * OCR 出来的换行往往是图像排版造成的，中文文本里没什么意义。
 */
export function cleanOcrText(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => {
      if (!l) return false;
      // 去掉只有标点/单字符的噪声行
      const meaningful = l.replace(/[^\p{L}\p{N}]/gu, '');
      return meaningful.length >= 2;
    });
  return lines.join('\n');
}

/** 语言包目录里有什么，供界面显示 */
export function tessdataInfo(): { dir: string; files: { name: string; bytes: number }[] } {
  if (!existsSync(TESSDATA_DIR)) return { dir: TESSDATA_DIR, files: [] };
  return {
    dir: TESSDATA_DIR,
    files: readdirSync(TESSDATA_DIR)
      .filter((n) => n.endsWith('.traineddata'))
      .map((n) => ({ name: n, bytes: statSync(join(TESSDATA_DIR, n)).size })),
  };
}
