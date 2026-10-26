import {checkedOfficeBytes,readOfficeBytes} from './office-package.ts';
/**
 * 文档文本抽取 —— 用于建立全文索引，以及给大模型当参考资料。
 *
 * 支持：docx（正文 + 表格）、xlsx（单元格）、pptx（文本框）、
 *       txt/md/csv/json/xml/html；异步PDF抽取使用本地PDF.js文字层，扫描件明确待OCR。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import PizZip from './office-package.ts';

const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.json', '.xml', '.html', '.htm', '.log', '.yml', '.yaml', '.ini']);

export interface ExtractResult {
  text: string;
  /** 抽取方式，便于排错 */
  method: 'plain' | 'docx' | 'xlsx' | 'pptx' | 'pdf-text' | 'pdfjs' | 'none';
  ok: boolean;
  message?: string;
}

function decodeText(buf: Buffer): string {
  // 先按 UTF-8 解，出现大量替换字符则按 GBK 再试
  const utf8 = buf.toString('utf8');
  const bad = (utf8.match(/\uFFFD/g) ?? []).length;
  if (bad > utf8.length * 0.02) {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return utf8;
    }
  }
  return utf8;
}

/** 从 XML 里按标签抽文本，保持段落顺序 */
function xmlToText(xml: string, opts: { paraTags: string[]; textTag: string }): string {
  const out: string[] = [];
  const paraRe = new RegExp(`<(${opts.paraTags.join('|')})[ >][\\s\\S]*?</\\1>|<(${opts.paraTags.join('|')})/>`, 'g');
  const textRe = new RegExp(`<${opts.textTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${opts.textTag}>|<(w:br|w:cr|a:br|w:tab)(?:\\s[^>]*)?\\s*/>`, 'g');
  const decode = (s: string) =>
    s
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");

  let m: RegExpExecArray | null;
  while ((m = paraRe.exec(xml))) {
    const body = m[0];
    const parts: string[] = [];
    let t: RegExpExecArray | null;
    textRe.lastIndex = 0;
    while ((t = textRe.exec(body))) parts.push(t[2] ? (t[2]==='w:tab'?'\t':'\n') : decode(t[1] ?? ''));
    const line = parts.join('').trim();
    // 空段落保留为空行：下游要靠它识别标题和段落边界
    out.push(line);
  }
  // 用空行分隔段落，而不是单换行——否则整篇会被当成一个段落，
  // 知识库切块和标题识别都会失效。
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function unzipText(buf: Buffer): PizZip {
  return new PizZip(buf);
}

export function extractDocx(buf: Buffer): string {
  const zip = unzipText(buf);
  const doc = zip.file('word/document.xml');
  const parts: string[] = [];
  if (doc) {
    const xml = doc.asText();
    // 表格单元格用制表符分隔：先按行拆
    const tableAware = xml
      .replace(/<w:tbl>/g, '\n[[TABLE]]\n')
      .replace(/<\/w:tbl>/g, '\n[[/TABLE]]\n')
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<\/w:tr>/g, '\n');
    parts.push(xmlToText(tableAware, { paraTags: ['w:p', 'w:tr'], textTag: 'w:t' }));
  }
  // 页眉页脚也一并取（常有文号、单位名）
  for (const name of ['word/header1.xml', 'word/header2.xml', 'word/header3.xml', 'word/footer1.xml', 'word/footer2.xml']) {
    const f = zip.file(name);
    if (f) {
      const t = xmlToText(f.asText(), { paraTags: ['w:p'], textTag: 'w:t' }).trim();
      if (t) parts.push(t);
    }
  }
  return parts.join('\n').replace(/\[\[TABLE\]\]|\[\[\/TABLE\]\]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 只读 docx 的「抬头」：页眉页脚 + 正文开头若干字。
 *
 * B3-8 的抽取任务要**先判文号、再定去重**，而完整抽正文（含表格）比这贵得多。
 * 文号几乎只出现在页眉/页脚（`…〔2026〕12号`）和正文最前面几行，所以这里只解压
 * `word/header*.xml` / `word/footer1.xml` 与 `word/document.xml` 的开头，
 * 用最省的方式把 `<w:t>` 文本抓出来。抽不动（坏文件、非 docx 结构）返回空串，
 * 由调用方按「没抬头」继续 —— 抬头只是判定的加分项，不是失败条件。
 */
export function extractDocxHead(buf: Buffer, maxChars = 1200): string {
  let zip: PizZip;
  try {
    zip = unzipText(buf);
  } catch {
    return '';
  }
  const parts: string[] = [];
  for (const name of ['word/header1.xml', 'word/header2.xml', 'word/header3.xml', 'word/footer1.xml', 'word/footer2.xml']) {
    const f = zip.file(name);
    if (!f) continue;
    const t = xmlToText(f.asText(), { paraTags: ['w:p'], textTag: 'w:t' }).trim();
    if (t) parts.push(t);
  }
  const doc = zip.file('word/document.xml');
  if (doc) {
    const xml = doc.asText();
    // 只取前 40KB 的 XML：抬头需要的文号/标题都在最前面，后面的正文留给完整抽取
    parts.push(tagText(xml.slice(0, 40_000)).slice(0, maxChars));
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars);
}

/** 把一段 OOXML 片段里的文本节点抓出来（保留段落换行，别的标签一律丢掉） */
function tagText(xml: string, textTag = 'w:t'): string {
  const out: string[] = [];
  const paraRe = /<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g;
  const textRe = new RegExp(`<${textTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${textTag}>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = paraRe.exec(xml))) {
    const body = m[0];
    const parts: string[] = [];
    let t: RegExpExecArray | null;
    textRe.lastIndex = 0;
    while ((t = textRe.exec(body))) parts.push((t[1] ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    out.push(parts.join('').trim());
  }
  return out.join('\n');
}

export function extractPptx(buf: Buffer): string {  const zip = unzipText(buf);
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number(a.match(/(\d+)/)?.[1] ?? 0);
      const nb = Number(b.match(/(\d+)/)?.[1] ?? 0);
      return na - nb;
    });
  const out: string[] = [];
  slides.forEach((name, i) => {
    const f = zip.file(name);
    if (!f) return;
    const t = xmlToText(f.asText(), { paraTags: ['a:p'], textTag: 'a:t' }).trim();
    if (t) out.push(`【第 ${i + 1} 页】\n${t}`);
  });
  return out.join('\n\n');
}

/** PDF：不引第三方库，尝试抽取未压缩的文本流（能出多少算多少） */
export function extractPdfLoose(buf: Buffer): ExtractResult {
  // This fallback is deliberately bounded. Binary scan streams are not text;
  // overlapping escape alternatives previously stalled imports on real scanned PDFs.
  const raw = buf.subarray(0,4*1024*1024).toString('latin1');
  const chunks: string[] = [];
  const re = /\(((?:\\.|[^\\()]){0,8192})\)\s*Tj|\[((?:\\.|[^\\\[\]]){0,8192})\]\s*TJ/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const s = m[1] ?? m[2] ?? '';
    const cleaned = s.replace(/\\([()\\])/g, '$1').replace(/\\[0-7]{1,3}/g, ' ');
    if (/[\u4e00-\u9fff]/.test(cleaned) || /[A-Za-z]{3,}/.test(cleaned)) chunks.push(cleaned);
  }
  const text = chunks.join(' ').replace(/\s+/g, ' ').trim();
  if (!text) {
    return { text: '', method: 'none', ok: false, message: 'PDF 文本流被压缩或为扫描件，需要 OCR' };
  }
  return { text, method: 'pdf-text', ok: true };
}

export function extractText(absPath: string): ExtractResult {
  let buf: Buffer;
  try {
    buf = readFileSync(absPath);
  } catch (e) {
    return { text: '', method: 'none', ok: false, message: `读取失败：${(e as Error).message}` };
  }
  return extractTextFromBuffer(buf, absPath);
}

/**
 * 从**已经读进内存的字节**里抽文本。
 *
 * 为什么要有这一层（B3-8 知识库抽取）：抽取是后台任务，它按「批量并发读文件」推进，
 * 并且每个文件只读一次（读到的字节同时用来算 sha256 和抽文本）。如果沿用
 * {@link extractText} 的「自己再去 readFileSync」，同一次抽取里每个文件要读两遍，
 * 而且那一遍是**同步**读 —— 大文件会把事件循环按在地上（本项目"备份阻塞事件循环"的
 * 前车之鉴就是这么来的）。所以这里把「读」和「解析」拆开：调用方异步读，解析用纯函数。
 *
 * @param asName 只用来取扩展名判断类型（不读该路径）
 */
export function extractTextFromBuffer(buf: Buffer, asName: string): ExtractResult {
  const ext = extname(asName).toLowerCase();
  try {
    if (TEXT_EXT.has(ext)) return { text: decodeText(buf).slice(0, 2_000_000), method: 'plain', ok: true };
    if (ext === '.docx') return { text: extractDocx(buf), method: 'docx', ok: true };
    if (ext === '.pptx') return { text: extractPptx(buf), method: 'pptx', ok: true };
    if (ext === '.pdf') return extractPdfLoose(buf);
    if (ext === '.doc' || ext === '.xls' || ext === '.ppt') {
      return { text: '', method: 'none', ok: false, message: `${ext} 是旧版二进制格式，请另存为 docx/xlsx 后再入库` };
    }
    return { text: '', method: 'none', ok: false, message: `暂不支持抽取 ${ext || '未知'} 类型的文本` };
  } catch (e) {
    return { text: '', method: 'none', ok: false, message: `解析失败：${(e as Error).message}` };
  }
}

/** xlsx 抽取用 exceljs（异步），单独导出 */
export async function extractXlsx(absPath: string): Promise<string> {  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readOfficeBytes(absPath) as never);
  const out: string[] = [];
  wb.eachSheet((ws) => {
    out.push(`【工作表：${ws.name}】`);
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const v = cell.value;
        if (v === null || v === undefined) {
          cells.push('');
        } else if (typeof v === 'object' && 'richText' in v && Array.isArray((v as { richText: { text: string }[] }).richText)) {
          cells.push((v as { richText: { text: string }[] }).richText.map((r) => r.text).join(''));
        } else if (typeof v === 'object' && 'result' in v) {
          cells.push(String((v as { result: unknown }).result ?? ''));
        } else if (v instanceof Date) {
          cells.push(v.toISOString().slice(0, 10));
        } else {
          cells.push(String(v));
        }
      });
      const line = cells.join('\t').replace(/\t+$/, '');
      if (line.trim()) out.push(line);
    });
  });
  return out.join('\n');
}

export async function extractAny(absPath: string): Promise<ExtractResult> {
  const ext = extname(absPath).toLowerCase();
  if (ext === '.pdf') return extractPdfText(readFileSync(absPath));
  if (ext === '.xlsx') {
    try {
      return { text: await extractXlsx(absPath), method: 'xlsx', ok: true };
    } catch (e) {
      return { text: '', method: 'none', ok: false, message: `xlsx 解析失败：${(e as Error).message}` };
    }
  }
  return extractText(absPath);
}

/**
 * 同 {@link extractAny}，但从内存字节出发 —— 抽取任务用的那条路。
 * xlsx 的读取器只认文件路径，所以先把字节落到**平台自己的临时目录**，
 * 读完立刻删（绝不落在用户目录里，契约 §11）。
 */
export async function extractAnyFromBuffer(buf: Buffer, asName: string, tmpDir: string): Promise<ExtractResult> {
  const ext = extname(asName).toLowerCase();
  if (ext === '.pdf') return extractPdfText(buf);
  if (ext !== '.xlsx') return extractTextFromBuffer(buf, asName);
  const tmp = join(tmpDir, `x-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`);
  try {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(tmp, buf);
    return { text: await extractXlsx(tmp), method: 'xlsx', ok: true };
  } catch (e) {
    return { text: '', method: 'none', ok: false, message: `xlsx 解析失败：${(e as Error).message}` };
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 临时文件删不掉不该让整批失败 */
    }
  }
}

/** Local PDF text only: page locations retained; no OCR, scripts, URL fetch or actions. */
export async function extractPdfText(bytes:Buffer):Promise<ExtractResult> {
 if(bytes.length>8*1024*1024)return {ok:false,text:'',method:'none',message:'PDF超过8MB抽取上限'};
 let task:ReturnType<typeof import('pdfjs-dist/legacy/build/pdf.mjs')['getDocument']>|undefined;
 try {
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  task=getDocument({data:new Uint8Array(bytes),useSystemFonts:false,disableFontFace:true,useWorkerFetch:false,verbosity:0});
  const doc=await task.promise,parts:string[]=[],blank:number[]=[];let count=0;
  for(let n=1;n<=Math.min(doc.numPages,100)&&count<200000;n++){
   const page=await doc.getPage(n),content=await page.getTextContent();
   const text=content.items.map(i=>'str' in i?i.str+('hasEOL' in i&&i.hasEOL?'\n':' '):'').join('').trim();
   if(text){parts.push(`【PDF第${n}页】\n${text.slice(0,200000-count)}`);count+=text.length;}else blank.push(n);
   page.cleanup();
  }
  if(!parts.length)return {ok:false,text:'',method:'none',message:'无法提取正文／待OCR：PDF未发现可提取的文字层'};
  return {ok:true,text:parts.join('\n'),method:'pdfjs',message:[blank.length?`第${blank.join('、')}页无可提取正文，可能待OCR`:'',doc.numPages>100||count>=200000?'超过100页或20万字读取预算，仅抽取部分内容':''].filter(Boolean).join('；')||undefined};
 }catch{return {ok:false,text:'',method:'none',message:'PDF加密、损坏或无法解析；需人工阅读或提供可提取正文的副本'};}
 finally{await task?.destroy();}
}
