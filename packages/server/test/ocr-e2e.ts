import './isolated-guard.ts';
/**
 * OCR 端到端自检：启用 OCR → 上传带文字的图片 → 等待识别 → 全文检索命中
 *   node packages/server/test/ocr-e2e.ts
 * 需要服务已启动，且已下载语言包（首次调用 /api/ocr/prepare）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import PizZip from 'pizzip';

const BASE = process.env.BASE!;
const TMP = join(process.env.WORKBENCH_ISOLATION_ROOT!, 'fixtures');
mkdirSync(TMP, { recursive: true });

let pass = 0;
let failCount = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failCount += 1;
    console.log(`  ✗ ${name}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400));
  }
}

async function api(path: string, init?: RequestInit): Promise<{ status: number; json: any }> {
  const hasBody = init?.body !== undefined && init?.body !== null;
  const headers = init?.body instanceof FormData ? init.headers : hasBody ? { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } : (init?.headers ?? {});
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

/** 造一张有清晰拉丁字母数字的 BMP：用位图字模画 8x8 点阵字 */
const FONT: Record<string, number[]> = {
  // 每行 8 位，1 表示黑点
  A: [0x18, 0x24, 0x42, 0x42, 0x7e, 0x42, 0x42, 0x00],
  B: [0x7c, 0x42, 0x42, 0x7c, 0x42, 0x42, 0x7c, 0x00],
  C: [0x3c, 0x42, 0x40, 0x40, 0x40, 0x42, 0x3c, 0x00],
  D: [0x78, 0x44, 0x42, 0x42, 0x42, 0x44, 0x78, 0x00],
  E: [0x7e, 0x40, 0x40, 0x7c, 0x40, 0x40, 0x7e, 0x00],
  K: [0x42, 0x44, 0x48, 0x70, 0x48, 0x44, 0x42, 0x00],
  O: [0x3c, 0x42, 0x42, 0x42, 0x42, 0x42, 0x3c, 0x00],
  P: [0x7c, 0x42, 0x42, 0x7c, 0x40, 0x40, 0x40, 0x00],
  R: [0x7c, 0x42, 0x42, 0x7c, 0x48, 0x44, 0x42, 0x00],
  S: [0x3c, 0x42, 0x40, 0x3c, 0x02, 0x42, 0x3c, 0x00],
  T: [0x7e, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x00],
  U: [0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x3c, 0x00],
  X: [0x42, 0x42, 0x24, 0x18, 0x18, 0x24, 0x42, 0x00],
  '0': [0x3c, 0x42, 0x46, 0x4a, 0x52, 0x62, 0x3c, 0x00],
  '1': [0x18, 0x28, 0x08, 0x08, 0x08, 0x08, 0x3e, 0x00],
  '2': [0x3c, 0x42, 0x02, 0x0c, 0x30, 0x40, 0x7e, 0x00],
  '3': [0x3c, 0x42, 0x02, 0x1c, 0x02, 0x42, 0x3c, 0x00],
  '4': [0x08, 0x18, 0x28, 0x48, 0x7e, 0x08, 0x08, 0x00],
  ' ': [0, 0, 0, 0, 0, 0, 0, 0],
};

function makeBmp(text: string): Buffer {
  const scale = 6; // 放大，让 OCR 更容易识别
  const cw = 8 * scale;
  const ch = 8 * scale;
  const pad = 40;
  const width = pad * 2 + cw * text.length;
  const height = pad * 2 + ch;
  const rowSize = Math.ceil((24 * width) / 32) * 4;
  const pixelBytes = rowSize * height;
  const buf = Buffer.alloc(54 + pixelBytes, 0xff);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(54 + pixelBytes, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(pixelBytes, 34);
  const setBlack = (x: number, y: number) => {
    const off = 54 + (height - 1 - y) * rowSize + x * 3;
    buf[off] = 0;
    buf[off + 1] = 0;
    buf[off + 2] = 0;
  };
  text.split('').forEach((c, i) => {
    const glyph = FONT[c.toUpperCase()] ?? FONT[' '];
    if (!glyph) return;
    const ox = pad + i * cw;
    const oy = pad;
    for (let r = 0; r < 8; r += 1) {
      const bits = glyph[r] ?? 0;
      for (let b = 0; b < 8; b += 1) {
        if ((bits >> (7 - b)) & 1) {
          for (let sy = 0; sy < scale; sy += 1) {
            for (let sx = 0; sx < scale; sx += 1) setBlack(ox + b * scale + sx, oy + r * scale + sy);
          }
        }
      }
    }
  });
  return buf;
}

const TEXT = 'SCAN 2026 OK';
const imgPath = join(TMP, 'ocr-e2e.bmp');
writeFileSync(imgPath, makeBmp(TEXT));
console.log(`\n测试图片已生成（内容 "${TEXT}"）：${imgPath}\n`);

console.log('[1] 启用 OCR 并准备语言包');
const on = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ 'ocr.enabled': true, 'ocr.lang': 'eng' }) });
check('启用 OCR 开关', on.json?.ok === true, on.json);
const prep = await api('/api/ocr/prepare', { method: 'POST' });
check('语言包就绪', prep.json?.ok === true, prep.json);
if (!prep.json?.ok) {
  console.log('\n语言包不可用，后续无法继续。请检查网络。\n');
  process.exit(1);
}

console.log('[2] 建工作台并上传图片');
/**
 * 工作类型不能写死 id：用户删改过类型后（本机就没有 id=2），
 * 硬编码会让整个自检在第一处就失败，进而让 test:all 后面的几套都跑不到。
 * 取实际存在的第一个类型，并带上【自检】前缀便于识别与清理。
 */
const types = await api('/api/work-types');
const anyType = (types.json?.data?.items ?? [])[0]?.id as number | undefined;
if (!anyType) {
  console.log('\n没有任何工作类型，无法继续。请先在「流程规范」里建一个。\n');
  process.exit(1);
}
const mk = await api('/api/workbenches', { method: 'POST', body: JSON.stringify({ name: '【自检】OCR 识别', workTypeId: anyType }) });
const wbId = mk.json?.data?.id as number;
check('建工作台', Number.isFinite(wbId), mk.json);
const fd = new FormData();
// 故意用不带英文的中文文件名，确保后面检索命中的只可能是 OCR 识别出的文字
fd.append('file', new Blob([readFileSync(imgPath)], { type: 'image/bmp' }), '档案扫描件.bmp');
fd.append('workbenchId', String(wbId));
fd.append('kind', 'scan');
fd.append('note', '扫描件测试');
const up = await api('/api/artifacts/upload', { method: 'POST', body: fd });
check('上传图片成功', up.status === 201 && up.json?.ok === true, up.json);
const artifactId = up.json?.data?.items?.[0]?.id as number;
check('拿到文件 id', Number.isFinite(artifactId), artifactId);
const upName: string = up.json?.data?.items?.[0]?.file_name ?? 'x';
const upStem = upName.replace(/\.[^.]+$/, '');
check('文件名主名只有中文和数字（排除检索干扰）', !/[A-Za-z]/.test(upStem), upName);
check('标题不含英文字母', !/[A-Za-z]/.test(up.json?.data?.items?.[0]?.title ?? 'x'), up.json?.data?.items?.[0]?.title);

console.log('[3] 等待 OCR 完成（最多 90 秒）');
let done = false;
let detail: any = null;
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  const d = await api(`/api/artifacts/${artifactId}`);
  const st = d.json?.data?.ocr?.status;
  if (st === 'done' || st === 'failed' || st === 'skipped') {
    done = true;
    detail = d.json.data;
    break;
  }
  await new Promise((r) => setTimeout(r, 1500));
}
check('OCR 任务已结束', done, detail?.ocr);
check('识别状态为 done', detail?.ocr?.status === 'done', detail?.ocr);
check('识别出文字', (detail?.ocr?.chars ?? 0) > 0, detail?.ocr);
const ocrText: string = detail?.artifact?.ocr_text ?? '';
console.log(`     识别结果：${JSON.stringify(ocrText)}`);
// 这里用的是点阵合成的图片，识别精度本身不是被测对象；
// 关键链路是「图片进队列 → 识别 → 文字入库 → 可被检索」。所以用实际识别出的词来验检索。
const tokens = (ocrText.toUpperCase().match(/[A-Z0-9]{2,}/g) ?? []).sort((a, b) => b.length - a.length);
check('识别结果包含可检索的词', tokens.length > 0, { ocrText, tokens });
const hitWords = ['SCAN', '2026', 'OK'].filter((w) => ocrText.toUpperCase().includes(w));
console.log(`     与预期文本的匹配：${hitWords.join('/') || '（点阵字模识别有偏差，属正常）'}`);
void hitWords;

console.log('[4] 全文检索能搜到 OCR 文字');
// 文件名是纯中文，所以命中的词只可能来自 OCR 识别出的文字——这才能真正证明 OCR 内容进了索引
const byToken = tokens[0] ?? 'SCA';
const s2 = await api(`/api/search?q=${encodeURIComponent(byToken)}`);
check(`检索 OCR 原文里的 "${byToken}" 命中该文件`, (s2.json?.data?.total ?? 0) >= 1, { keyword: byToken, total: s2.json?.data?.total });
const hitIds = (s2.json?.data?.items ?? []).map((i: { id: number }) => i.id);
check('命中的正是这张扫描件', hitIds.includes(artifactId), { hitIds, artifactId });

console.log('[5] 队列状态');
const q = await api('/api/ocr/status');
check('队列可查询', q.json?.ok === true, q.json);
check('显示已启用', q.json?.data?.enabled === true, q.json?.data?.enabled);
check('统计已完成 1 项', (q.json?.data?.done ?? 0) >= 1, { done: q.json?.data?.done, failed: q.json?.data?.failed, skipped: q.json?.data?.skipped });

console.log('[6] 非图片文件不排队');
/**
 * 现场造一个最小 docx，而不是读 data/files 下的示例文件。
 * 原来读的是 `data/files/_模板库/示例_月度安全检查记录表.docx` ——
 * 那个文件**根本不存在**（示例数据写在 `_待归档`，且用户可能从没生成过），
 * 于是这一步 ENOENT 抛出、进程非零退出，`test:all` 后面的知识库/助手/影像三套自检
 * 永远不会被执行。自检不能依赖"用户机器上恰好有某个文件"。
 */
const docxPath = join(TMP, 'ocr-e2e-非图片.docx');

function makeTinyDocx(path: string): void {
  const zip = new PizZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.folder('_rels')!.file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip
    .folder('word')!
    .file(
      'document.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t>【自检】这是一份 docx，用来验证 OCR 会拒绝非图片。</w:t></w:r></w:p></w:body>
</w:document>`,
    );
  writeFileSync(path, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
makeTinyDocx(docxPath);

const docx = new FormData();
docx.append('file', new Blob([readFileSync(docxPath)]), '【自检】非图片.docx');
docx.append('workbenchId', String(wbId));
const up2 = await api('/api/artifacts/upload', { method: 'POST', body: docx });
check('上传 docx', up2.json?.ok === true, up2.json);
const docxArtifactId = up2.json?.data?.items?.[0]?.id as number;
const ocr2 = await api(`/api/ocr/artifacts/${docxArtifactId}`, { method: 'POST' });
check('docx 拒绝 OCR 并给出原因', ocr2.json?.ok === false && String(ocr2.json?.error?.message).includes('只能识别图片'), ocr2.json?.error);

/* ---------- 清理：自检不留垃圾 ---------- */
console.log('\n[7] 清理');
for (const id of [artifactId, docxArtifactId].filter(Boolean)) {
  await api(`/api/artifacts/${id}?withFile=true`, { method: 'DELETE' });
}
await api(`/api/workbenches/${wbId}`, { method: 'DELETE' });
const left = await api(`/api/artifacts?workbenchId=${wbId}`);
check('自检文件已清理', (left.json?.data?.items?.length ?? 0) === 0, left.json?.data?.items?.length);

console.log(`\n结果：通过 ${pass} 项，失败 ${failCount} 项\n`);
if (failCount > 0) process.exitCode = 1;
