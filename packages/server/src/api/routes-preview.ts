/**
 * 页面内预览接口（清单 B4-12「真·预览」）
 *
 * 要解决的问题（现状已核实）：想看一份文件长什么样，只能点「下载」——
 * 用户必须离开浏览器、在磁盘上留一个副本；坏文件更是"下载得到、打不开"。
 * 这里给界面一条**只读**路径：按 artifact id 拿到「可预览的内容」，并且
 * **明确告诉前端该怎么渲染**（`kind` / `renderAs`），不让前端猜。
 *
 * 口径（这一步最要紧的是别假装）：
 *   · 图片 png/jpg/jpeg/gif/webp/bmp → 回字节流，`kind:'image'` + `renderAs:'img'`；
 *   · PDF                            → 回字节流，`kind:'pdf'` + `renderAs:'iframe'`，
 *                                      支持 `Range`（浏览器的 PDF 阅读器会按需拉片段）；
 *   · 文本 txt/md/csv/json/log/xml…  → 回 UTF-8 文本内联在 JSON 里，`renderAs:'text'`；
 *                                      上限 2 MiB，超出**截断并在响应里标注**（truncated/totalBytes）；
 *   · xlsx → 有界单元格及合并表格预览；字体、分页及公式重算以 Excel 为准。
 *   · docx → 只提供正文摘要；完整排版须使用 Office 查看。
 *   · 其它（doc/xls/ppt/pptx/zip/tiff…）→ `supported:false` + 人话原因（tiff：浏览器不支持）。
 *
 * 安全（三条硬约束，都能在代码里指出来）：
 *   ① **路径不由请求里的字符串拼出来**：请求只带一个整数 id（`intParam`），
 *      绝对路径一律现算 —— `artifactAbsPath()` 内部走 `resolveInAnyRoot` / `isInsideRoot` 的
 *      **允许根校验**，再由 `resolveRegisteredFile()` 在允许根白名单里兜底（同步盘换盘符的情形）。
 *   ② 登记记录里的相对路径若越界（含 `..`）→ `resolveInAnyRoot` 抛错 → 这里转成 **403**，
 *      并且**不回显绝对路径**（原始错误信息里带路径，一律替换成人话）。
 *   ③ 记录不存在 / 已进回收站 → **404**；记录在、文件不在磁盘（被手工删/移走）→ **410 + 可读原因**，
 *      不是 500。响应里**不出现任何绝对路径**（只给登记的相对路径，这个值本来就由 /api/artifacts 返回）。
 *
 * `/preview/raw` **只服务**图片与 PDF 两类白名单扩展名：其它类型一律 415。
 * 理由：把任意类型的文件按记录里的 mime 内联发出去，等于给了"上传一个 .html 再在同源打开它"
 * 的存储型 XSS 通路（`X-Content-Type-Options: nosniff` 挡不住声明正确的 text/html）。
 * 文本类不需要走字节流（内容在 JSON 里），docx/xlsx 本来就不该假装能渲染。
 */
import { closeSync, createReadStream, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { extractDocx, extractXlsx } from '../core/extract.ts';
import { artifactAbsPath, getArtifact, mimeOf, resolveRegisteredFile, type Artifact } from '../core/store.ts';
import { ApiError, fail, intParam, ok } from './reply.ts';
import ExcelJS from 'exceljs';
import OfficeZip from '../core/office-package.ts';

/** 浏览器能**原生**渲染的图片扩展名（tiff/tif 不在内：浏览器不支持，宁可说不支持） */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
/** 当纯文本显示：内容走 JSON（前端 <pre>），不按字节流内联，避免同源 HTML 执行 */
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.xml', '.yml', '.yaml', '.ini', '.html', '.htm', '.sql', '.conf']);
/** 文本预览上限：超过就截断（并在响应里标注 truncated / totalBytes） */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** docx/xlsx「文本摘要」的字数上限 */
const MAX_EXCERPT_CHARS = 4000;
/** Office 包的读取闸门：超过这个尺寸不抽摘要（宁可说"太大，下载后用 Office 看"） */
const MAX_OFFICE_BYTES = 8 * 1024 * 1024;

type PreviewKind = 'image' | 'pdf' | 'text' | 'spreadsheet' | 'unsupported';

export interface PreviewPayload {
  sheets?:{name:string;rows:{text:string;colSpan:number;rowSpan:number}[][]}[];
  id: number;
  title: string;
  fileName: string;
  /** 登记的相对路径（与 /api/artifacts 一致，不是绝对路径） */
  fileRel: string;
  kind: PreviewKind;
  supported: boolean;
  renderAs: 'img' | 'iframe' | 'text' | 'none';
  mime: string;
  /** 磁盘上的真实字节数（不是数据库里记的那个可能过期的值） */
  sizeBytes: number;
  recordedBytes: number | null;
  /** kind=image/pdf 时给前端 <img>/<iframe> 用的地址；其它为 null */
  contentUrl: string | null;
  /** 兜底下载（**既有**下载接口，行为未改动） */
  downloadUrl: string;
  /** kind=text：正文（已按上限截断） */
  text?: string;
  encoding?: string;
  truncated?: boolean;
  chars?: number;
  /** kind=unsupported：抽取出的纯文本摘要（docx/xlsx 才有） */
  excerpt?: string;
  excerptNote?: string;
  /** kind=unsupported：为什么不能预览（人话） */
  reason?: string;
  /** 给界面写的口径说明（例如"内容预览，字体与分页以 Word 为准"） */
  note?: string;
}

/** 扩展名 → 预览口径 */
function extOf(a: Artifact): string {
  const fromName = extname(a.file_name || '').toLowerCase();
  if (fromName) return fromName;
  const raw = (a.file_ext ?? '').toLowerCase();
  return raw && !raw.startsWith('.') ? `.${raw}` : raw;
}

function kindOfExt(ext: string): PreviewKind {
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'unsupported';
}

/**
 * 记录 → 磁盘绝对路径，**必经允许根校验**。
 * 分三种结果，绝不混成一个 500：
 *   · 越界（登记里带 `..`）→ 403，且不回显绝对路径；
 *   · 定位不到（工作台被删 / 已解绑外部目录）→ 410 + 领域层原文（只有相对路径，没有绝对路径）；
 *   · 正常 → 绝对路径。
 */
function absOf(a: Artifact): string {
  try {
    return artifactAbsPath(a);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('越界')) throw new ApiError('PATH_REJECTED', '登记的文件路径越界，已拒绝访问', 403);
    throw new ApiError('FILE_UNLOCATABLE', `暂时无法定位这个文件：${msg}`, 410);
  }
}

/** 定位 + 存在性 + 磁盘真实大小；文件不在磁盘时回 410（可读），不是 500 */
function locate(a: Artifact): { abs: string; size: number } {
  const preferred = absOf(a);
  // 再在允许根白名单里兜一次底：绑定的目录换了盘符/路径时，按同一个 file_rel 找回来
  const abs = resolveRegisteredFile(a.file_rel, preferred);
  if (!abs) throw new ApiError('FILE_MISSING', `文件已不在磁盘上（登记位置：${a.file_rel}）`, 410);
  let size = 0;
  try {
    size = statSync(abs).size;
  } catch {
    throw new ApiError('FILE_MISSING', `文件已不在磁盘上（登记位置：${a.file_rel}）`, 410);
  }
  return { abs, size };
}

/** 只读文件开头 max 字节（不把整个大文件读进内存），同时拿到真实总长度 */
function readHead(abs: string, max: number): { buf: Buffer; total: number } {
  const fd = openSync(abs, 'r');
  try {
    const total = Number(fstatSync(fd).size);
    const want = Math.max(0, Math.min(total, max));
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, got);
      if (n <= 0) break;
      got += n;
    }
    return { buf: buf.subarray(0, got), total };
  } finally {
    closeSync(fd);
  }
}

/**
 * 文本解码：与 `core/extract.ts` 的 `decodeText` 同一口径（先 UTF-8，替换字符过多再试 GBK）。
 * 截断时额外做一件事：**去掉尾部那个落在多字节字符中间的替换字符** —— 宁可少显示一个字，
 * 也不要在页面上吐一个"半个汉字"变成的乱码方块。
 */
function decodeHead(buf: Buffer): { text: string; encoding: string } {
  const utf8 = buf.toString('utf8');
  const bad = (utf8.match(/\uFFFD/g) ?? []).length;
  let text = utf8;
  let encoding = 'utf-8';
  if (utf8.length > 0 && bad > utf8.length * 0.02) {
    try {
      const gbk = new TextDecoder('gbk').decode(buf);
      if (gbk.length) {
        text = gbk;
        encoding = 'gbk';
      }
    } catch {
      /* 保持 utf-8 */
    }
  }
  if (text.endsWith('\uFFFD')) text = text.slice(0, -1);
  return { text, encoding };
}

/** docx/xlsx 的「文本摘要」：抽得到就给，抽不到就只给 supported:false（绝不假装） */
async function textExcerpt(abs: string, size: number, ext: string): Promise<string | undefined> {
  try {
    if (ext === '.docx') {
      if (size > MAX_OFFICE_BYTES) return undefined; // 超大包不整份读进内存（截断的 zip 也抽不出东西）
      const { buf } = readHead(abs, size);
      return extractDocx(buf).slice(0, MAX_EXCERPT_CHARS) || undefined;
    }
    if (ext === '.xlsx') {
      if (size > MAX_OFFICE_BYTES) return undefined;
      const text = await extractXlsx(abs);
      return text.slice(0, MAX_EXCERPT_CHARS) || undefined;
    }
  } catch {
    return undefined; // 文件损坏/不是合法 Office 包：摘要给不出来就不给，reason 里已说明请下载查看
  }
  return undefined;
}

/** 不能预览的原因（人话，逐类型写清，不笼统说"不支持"） */
function unsupportedReason(ext: string): string {
  switch (ext) {
    case '.docx':
      return 'docx 是排版格式（字体/分页/表格样式都在包里），浏览器不能渲染它。要看版式请下载后用 Word 打开。';
    case '.xlsx':
      return 'xlsx 是表格排版格式，浏览器不能渲染它。要看表格请下载后用 Excel 打开。';
    case '.doc':
    case '.xls':
    case '.ppt':
      return `${ext} 是旧版二进制格式，既不能在浏览器里渲染，也抽不出文本；请下载后用 Office 打开（或另存为 docx/xlsx 后再入库）。`;
    case '.pptx':
      return 'pptx 是幻灯片排版格式，浏览器不能渲染它；请下载后用 PowerPoint 打开。';
    case '.tif':
    case '.tiff':
      return 'TIFF 图片浏览器不能直接显示（这个格式在浏览器里没有解码器）；请下载后用看图工具打开，或另存为 png/jpg 后再上传。';
    case '.zip':
      return '压缩包没有"内容预览"这回事；请下载后解压查看。';
    default:
      return `${ext || '这个'} 类型没有页面内预览，请下载后查看。`;
  }
}

async function buildPreview(id: number, a: Artifact): Promise<PreviewPayload> {
  const { abs, size } = locate(a);
  const ext = extOf(a);
  const kind = kindOfExt(ext);
  const base = {
    id,
    title: a.title || a.file_name,
    fileName: a.file_name,
    fileRel: a.file_rel,
    sizeBytes: size,
    recordedBytes: a.size_bytes ?? null,
    downloadUrl: `/api/artifacts/${id}/file`,
  };

  if (kind === 'image' || kind === 'pdf') {
    return {
      ...base,
      kind,
      supported: true,
      renderAs: kind === 'image' ? 'img' : 'iframe',
      // 渲染的 Content-Type 按白名单扩展名定，不信任可能过期的 artifact.mime
      mime: kind === 'image' ? mimeOf(a.file_name) : 'application/pdf',
      contentUrl: `/api/artifacts/${id}/preview/raw`,
      note: kind === 'image' ? '图片按原图显示（可缩放查看的是原字节，不是缩略图）。' : 'PDF 由浏览器内置阅读器显示；若这里是空白，说明本机浏览器不支持内嵌 PDF，请点「下载」查看。',
    };
  }

  if (kind === 'text') {
    const { buf, total } = readHead(abs, MAX_TEXT_BYTES);
    const truncated = total > buf.length;
    const { text, encoding } = decodeHead(buf);
    return {
      ...base,
      kind,
      supported: true,
      renderAs: 'text',
      mime: mimeOf(a.file_name),
      contentUrl: null,
      text,
      encoding,
      truncated,
      chars: text.length,
      note: truncated
        ? `文件较大（${total} 字节），页面里只显示前 ${buf.length} 字节（约 2 MB），后面的内容请下载查看。这是原文内容预览，不是排版渲染。`
        : '这是文件原文内容（按文本显示，不是排版渲染）。',
    };
  }

  if(ext==='.xlsx'&&size<=MAX_OFFICE_BYTES){
    const {buf}=readHead(abs,size);new OfficeZip(buf);
    const book=new ExcelJS.Workbook();await book.xlsx.load(buf as unknown as ExcelJS.Buffer);
    const sheets=book.worksheets.slice(0,5).map(sheet=>{
      const rows:{text:string;colSpan:number;rowSpan:number}[][]=[];
      for(let r=1;r<=Math.min(sheet.rowCount,100);r++){
        const cells:{text:string;colSpan:number;rowSpan:number}[]=[];
        for(let c=1;c<=Math.min(sheet.columnCount,30);c++){
          const cell=sheet.getCell(r,c);if(cell.isMerged&&cell.master.address!==cell.address)continue;
          let colSpan=1,rowSpan=1;
          if(cell.isMerged){while(c+colSpan<=Math.min(sheet.columnCount,30)&&sheet.getCell(r,c+colSpan).master.address===cell.address)colSpan++;while(r+rowSpan<=Math.min(sheet.rowCount,100)&&sheet.getCell(r+rowSpan,c).master.address===cell.address)rowSpan++;}
          cells.push({text:cell.text.slice(0,10000),colSpan,rowSpan});
        }rows.push(cells);
      }return {name:sheet.name,rows};
    });
    return {...base,kind:'spreadsheet',supported:true,renderAs:'none',mime:mimeOf(a.file_name),contentUrl:null,sheets,note:'读取实际文件中的单元格与合并结构；最多5张表、每表100行30列。字体、打印分页及公式重算以Excel为准。'};
  }

  // docx / xlsx：不假装能预览版式，但给可核实的文本摘要
  const excerpt = await textExcerpt(abs, size, ext);
  const isOffice = ext === '.docx' || ext === '.xlsx';
  return {
    ...base,
    kind: 'unsupported',
    supported: false,
    renderAs: 'none',
    mime: mimeOf(a.file_name),
    contentUrl: null,
    excerpt,
    excerptNote: excerpt
      ? '下面是从文件里抽出的正文纯文本：只有文字，没有字体、字号、表格边框与分页 —— 这是文本摘要，不是排版预览。'
      : undefined,
    reason: unsupportedReason(ext),
    note: isOffice && !excerpt ? '这份文件没能抽出正文文本（可能内容为空或文件损坏），请下载后用 Office 打开确认。' : undefined,
  };
}

/** 单段 `Range` 解析；返回 null 表示"按整份发"（多段/不认识的写法交给浏览器自理） */
function parseRange(header: string, total: number): { start: number; end: number } | 'invalid' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, s, e] = m;
  if (s === '' && e === '') return null;
  let start: number;
  let end: number;
  if (s === '') {
    const n = Number(e);
    if (!Number.isFinite(n) || n <= 0) return 'invalid';
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = Number(s);
    end = e === '' ? total - 1 : Number(e);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
    if (end > total - 1) end = total - 1;
  }
  if (start > end || start >= total) return 'invalid';
  return { start, end };
}

/** `Content-Disposition: inline` —— 中文文件名用 RFC 5987 编码，另给一个 ASCII 兜底 */
function inlineDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function registerPreviewRoutes(app: FastifyInstance): void {
  /** 预览说明：告诉前端"这是什么、怎么渲染"，文本类内容直接内联 */
  app.get('/api/artifacts/:id/preview', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const a = getArtifact(id); // 默认排除回收站里的：删掉的文件不该还能预览
      if (!a) throw new ApiError('NOT_FOUND', '文件不存在（也可能已在回收站里，见「回收站」页）', 404);
      return ok(reply, await buildPreview(id, a));
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 原始字节流：**只服务图片与 PDF**（白名单），支持单段 `Range`。
   * 别的类型一律 415 —— 文本走 JSON，docx/xlsx 不假装能渲染，其它类型不给同源内联的通路。
   */
  app.get('/api/artifacts/:id/preview/raw', async (req: FastifyRequest, reply) => {
    try {
      const id = intParam(req, 'id');
      const a = getArtifact(id);
      if (!a) throw new ApiError('NOT_FOUND', '文件不存在（也可能已在回收站里，见「回收站」页）', 404);
      const ext = extOf(a);
      const kind = kindOfExt(ext);
      if (kind !== 'image' && kind !== 'pdf') {
        throw new ApiError('NOT_PREVIEWABLE', '这类文件不能按原始字节内联预览：文本类请用 /preview 的文本结果，Office/其它类型请下载后查看', 415);
      }
      const { abs, size } = locate(a);
      const mime = kind === 'image' ? mimeOf(a.file_name) : 'application/pdf';
      reply.header('Content-Type', mime);
      reply.header('Content-Disposition', inlineDisposition(a.file_name));
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Cache-Control', 'no-store');
      const range = parseRange(String(req.headers.range ?? ''), size);
      if (range === 'invalid') {
        return reply.code(416).header('Content-Range', `bytes */${size}`).type('text/plain; charset=utf-8').send('请求的字节范围不合法');
      }
      if (range) {
        const len = range.end - range.start + 1;
        return reply
          .code(206)
          .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
          .header('Content-Length', String(len))
          .send(createReadStream(abs, { start: range.start, end: range.end }));
      }
      reply.header('Content-Length', String(size));
      return reply.send(createReadStream(abs));
    } catch (e) {
      return fail(reply, e);
    }
  });
}
