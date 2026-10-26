import {checkedOfficeBytes,readOfficeBytes} from './office-package.ts';
/** 从字段标签、空位和通用占位符提出可审阅的变量建议。仅本地处理。 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import PizZip from './office-package.ts';
import { detectFormat } from './template.ts';

const LABELS = ['填表日期','填报日期','编制日期','报告日期','汇报日期','签订日期','签署日期','开工日期','完工日期','检查日期','检查时间','监督时间','监督日期','会议时间','会议日期','申请日期','报送日期','日期','时间','项目名称','工程名称','被检查项目','合同编号','合同金额','单位名称','接受监督单位','被检查单位','建设单位','施工单位','监理单位','部门名称','监督人员姓名','检查人员','检查人','审核人','编制人','填报人','负责人','经办人','联系人','联系电话','姓名','廉政监督内容','廉政监督情况记录','检查内容','检查结果','发现问题','整改情况','备注'].sort((a,b) => b.length-a.length);
const labelRe = new RegExp(LABELS.join('|'), 'g');
const exactLabel = (s: string) => LABELS.find(label => s.trim().replace(/[：:]+$/, '').trim() === label);
const generic = /\{(?:变量|待填|填写内容|内容)\}/g;
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export const templateFingerprint = (path: string) => hash(readFileSync(path));
type Target = { key: string; part?: string; paragraph?: number; sheet?: string; address?: string };
export interface FieldCandidate {
  id: string; name: string; type: 'text' | 'date'; location: string; context: string;
  original: string; reason: string; confidence: 'high' | 'review';
  start: number; end: number; target: Target;
}
interface Block { target: Target; text: string; location: string; nearby?: string }
const unxml = (s: string) => s.replace(/&#x([\da-f]+);/gi, (_,n) => String.fromCodePoint(parseInt(n,16))).replace(/&#(\d+);/g, (_,n) => String.fromCodePoint(Number(n))).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
const xml = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const paragraphRe = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
const textRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
const plain = (s: string) => [...s.matchAll(textRe)].map(m => unxml(m[1] ?? '')).join('');
const parts = (zip: PizZip) => Object.keys(zip.files).filter(p => /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(p));

function suggest(blocks: Block[]): FieldCandidate[] {
  const out: FieldCandidate[] = [];
  for (const block of blocks) {
    const occupied: {start:number;end:number}[] = [];
    const add = (name: string, start: number, end: number, reason: string, confidence: FieldCandidate['confidence'] = 'high') => {
      if (occupied.some(p => (start === end && p.start === start) || (start < p.end && end > p.start))) return;
      occupied.push({ start, end });
      const original = block.text.slice(start,end);
      out.push({ id: hash(`${block.target.key}:${start}:${end}`).slice(0,24), name, type: /日期|时间/.test(name) ? 'date' : 'text', location: block.location, context: block.text || `空白位置，邻近标签：${block.nearby ?? ''}`, original, reason, confidence, start,end,target:block.target });
    };
    const matches = [...block.text.matchAll(new RegExp(labelRe.source,'g'))];
    for (let i=0;i<matches.length;i++) {
      const match = matches[i]!;
      const name = match[0];
      const from = match.index! + name.length;
      const until = matches[i+1]?.index ?? block.text.length;
      const tail = block.text.slice(from,until);
      if (!/^[\s：:]/.test(tail)) continue;
      const colon = tail.match(/^[\s]*[：:][\s]*/);
      const start = from + (colon?.[0].length ?? (tail.match(/^\s*/)?.[0].length ?? 0));
      const content = block.text.slice(start,until);
      if (/日期|时间/.test(name)) {
        const date = content.match(/^(?:(?:\{变量\}|[\d_＿\s])*年\s*(?:\{变量\}|[\d_＿\s])*月\s*(?:\{变量\}|[\d_＿\s])*日|\d{4}[-/]\d{1,2}[-/]\d{1,2})/);
        if (date) { add(name,start,start+date[0].length,'根据日期标签和年月日结构识别；原有具体日期须确认后才能变量化', /\d/.test(date[0]) ? 'review' : 'high'); continue; }
      }
      const slot = content.match(/^(?:\{(?:变量|待填|填写内容|内容)\}|[_＿]{2,}|[—─]{2,}|[□〇]{2,})/);
      if (slot) add(name,start,start+slot[0].length,'根据前方字段标签识别待填位置');
      else if (colon && !content.trim() && !block.target.sheet) add(name,start,start,'字段标签后为空白，建议插入变量','review');
    }
    for (const hit of block.text.matchAll(new RegExp(generic.source,'g'))) {
      const before = block.text.slice(0,hit.index);
      const label = [...before.matchAll(new RegExp(labelRe.source,'g'))].at(-1)?.[0] ?? block.nearby;
      if (label) add(label,hit.index!,hit.index!+hit[0].length,'根据附近标签区分通用占位符','review');
    }
    if (block.nearby && /^(?:\s*|[_＿—─\s]+)$/.test(block.text)) add(block.nearby,0,block.text.length,'相邻单元格或段落是字段标签，此处为空白','review');
  }
  return out;
}

async function readBlocks(path: string, bytes: Buffer): Promise<Block[]> {
  const format = detectFormat(path);
  const blocks: Block[] = [];
  if (format === 'docx') {
    const zip = new PizZip(bytes);
    for (const part of parts(zip)) {
      const content = zip.file(part)!.asText();
      const paragraphs = [...content.matchAll(paragraphRe)];
      const contexts = new Map<number,string>();
      // 表格内优先看同一行左侧标签，再看该列的表头，避免把上一行的数据当标签。
      for (const table of content.matchAll(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g)) {
        let headers: (string | undefined)[] = [];
        for (const row of table[0].matchAll(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g)) {
          const cells = [...row[0].matchAll(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g)];
          const labels = cells.map(cell => exactLabel(plain(cell[0])));
          cells.forEach((cell,index) => {
            const label = labels[index-1] ?? headers[index];
            if (!label) return;
            const cellStart = table.index! + row.index! + cell.index!;
            paragraphs.forEach((p,pi) => { if (p.index! >= cellStart && p.index! < cellStart+cell[0].length) contexts.set(pi,label); });
          });
          if (!headers.length) headers = labels;
        }
      }
      paragraphs.forEach((p,index) => {
        const text = plain(p[0]);
        const nearby = contexts.get(index) ?? (index ? exactLabel(plain(paragraphs[index-1]![0])) : undefined);
        blocks.push({ target:{key:`${part}:${index}`,part,paragraph:index}, text, nearby, location:`${part === 'word/document.xml' ? '正文' : /^word\/header/.test(part) ? '页眉' : '页脚'} · 第 ${index+1} 段` });
      });
    }
  } else if (format === 'xlsx') {
    const ExcelJS = (await import('exceljs')).default;
    const book = new ExcelJS.Workbook(); await book.xlsx.load(checkedOfficeBytes(bytes) as never);
    book.eachSheet(sheet => {
      const lastColumn = Math.min(sheet.columnCount,512);
      const added = new Set<string>();
      const addCell = (row: number,col: number,nearby?: string) => {
        const cell = sheet.getCell(row,col);
        if (added.has(cell.address) || cell.type === ExcelJS.ValueType.Formula || (cell.isMerged && cell.master.address !== cell.address)) return;
        added.add(cell.address);
        const left = col > 1 ? sheet.getCell(row,col-1).text : '';
        const above = row > 1 ? sheet.getCell(row-1,col).text : '';
        blocks.push({ target:{key:`${sheet.name}!${cell.address}`,sheet:sheet.name,address:cell.address}, text:cell.text, nearby:nearby ?? exactLabel(left) ?? exactLabel(above), location:`${sheet.name}!${cell.address}` });
      };
      sheet.eachRow({includeEmpty:false},row => row.eachCell({includeEmpty:false},cell => {
        if (cell.isMerged && cell.master.address !== cell.address) return;
        addCell(row.number,Number(cell.col));
        const label = exactLabel(cell.text);
        if (label) {
          let col = Number(cell.col)+1;
          while (col <= lastColumn && sheet.getCell(row.number,col).isMerged && sheet.getCell(row.number,col).master.address === cell.address) col++;
          if (col <= lastColumn && !sheet.getCell(row.number,col).value) addCell(row.number,col,label);
        }
      }));
    });
  } else { throw new Error('智能识别目前支持 .docx、.xlsx 和 .xlsm 模板'); }
  return blocks;
}

export async function analyzeTemplateFields(path: string) {
  const bytes = readFileSync(path);
  return { fingerprint:hash(bytes), candidates:suggest(await readBlocks(path,bytes)) };
}

/** 在每个原有文本片段内替换，跨片段命中也保留原有 run/富文本样式。 */
function replacePieces(pieces: string[], replacements: {start:number;end:number;name:string}[]) {
  const spans = pieces.map((text,index) => ({start:pieces.slice(0,index).join('').length,end:pieces.slice(0,index+1).join('').length,text}));
  for (const r of [...replacements].sort((a,b) => b.start-a.start)) {
    let inserted = false;
    for (const p of spans) {
      if (r.start === r.end ? !inserted && r.start >= p.start && r.start <= p.end : r.start < p.end && r.end > p.start) {
        const from = Math.max(0,r.start-p.start), to = Math.min(p.text.length,r.end-p.start);
        p.text = p.text.slice(0,from)+(inserted?'':`{${r.name}}`)+p.text.slice(Math.max(from,to));
        inserted = true;
      }
    }
  }
  return spans.map(p => p.text);
}

export async function applyTemplateFields(path: string, candidates: FieldCandidate[], selections: {id:string;name:string}[]) {
  const chosen = selections.map(selection => {
    const candidate = candidates.find(c => c.id === selection.id);
    const name = selection.name.trim();
    if (!candidate || !/^[^{}\s|@#/]{1,60}$/.test(name)) throw new Error('识别项不存在或变量名不合法，请重新识别');
    return {...candidate,name};
  });
  if (new Set(chosen.map(c => c.id)).size !== chosen.length) throw new Error('不能重复选择同一个位置');
  const bytes = readFileSync(path);
  if (detectFormat(path) === 'docx') {
    const zip = new PizZip(bytes);
    for (const part of parts(zip)) {
      let index = -1;
      const content = zip.file(part)!.asText().replace(paragraphRe, paragraph => {
        index++;
        const replacements = chosen.filter(c => c.target.part === part && c.target.paragraph === index);
        if (!replacements.length) return paragraph;
        const nodes = [...paragraph.matchAll(textRe)];
        if (!nodes.length) {
          const run = `<w:r><w:t xml:space="preserve">${xml(replacements.map(c=>`{${c.name}}`).join(''))}</w:t></w:r>`;
          return paragraph.endsWith('/>') ? paragraph.slice(0,-2)+`>${run}</w:p>` : paragraph.replace('</w:p>',run+'</w:p>');
        }
        const replaced = replacePieces(nodes.map(n=>unxml(n[1] ?? '')),replacements);
        let ni = 0;
        return paragraph.replace(textRe,node => {
          const open = node.slice(0,node.indexOf('>'));
          return `${open}${/xml:space=/.test(open)?'':' xml:space="preserve"'}>${xml(replaced[ni++] ?? '')}</w:t>`;
        });
      });
      zip.file(part,content);
    }
    return zip.generate({type:'nodebuffer'});
  }
  const ExcelJS = (await import('exceljs')).default;
  const book = new ExcelJS.Workbook(); await book.xlsx.load(checkedOfficeBytes(bytes) as never);
  for (const key of new Set(chosen.map(c=>c.target.key))) {
    const replacements = chosen.filter(c=>c.target.key===key);
    const target = replacements[0]!.target;
    const cell = book.getWorksheet(target.sheet!)!.getCell(target.address!);
    if (cell.value && typeof cell.value === 'object' && 'richText' in cell.value) {
      const runs = cell.value.richText;
      const replaced = replacePieces(runs.map(run=>run.text),replacements);
      cell.value = {richText:runs.map((run,i)=>({...run,text:replaced[i] ?? ''}))};
    } else { cell.value = replacePieces([cell.text],replacements)[0] ?? ''; }
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}
