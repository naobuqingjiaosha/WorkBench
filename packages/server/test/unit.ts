/**
 * 纯函数单元测试：切块算法、向量编解码、余弦相似度、OCR 文本清洗、占位符渲染
 *   node packages/server/test/unit.ts
 * 不需要启动服务。
 */
import { chunkText, cosine, decodeVector, encodeVector } from '../src/core/kb.ts';
import { cleanOcrText } from '../src/core/ocr.ts';
import { renderText, scanPlaceholders, missingVariables } from '../src/core/placeholders.ts';
import { replaceInXml } from '../src/core/template.ts';
import { safeName, uniqueFileName, workbenchFolderName, generatedFileName, evidenceFileName, resolveInside } from '../src/core/paths.ts';
import { buildMatch, segCJK } from '../src/core/search.ts';
import { parseJsonLoose } from '../src/ai/gateway.ts';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300));
  }
}

/* ------------------------------ 切块 ------------------------------ */

console.log('\n[切块算法]');
{
  const para = '为规范设备到货验收工作，明确各方职责，特制定本办法。本办法适用于本单位所有设备采购项目的到货验收环节。';
  // 20 段 × 52 字 ≈ 1040 字
  const doc = ['设备验收管理办法', '', '第一章 总则', para, ...Array.from({ length: 18 }, () => para)].join('\n\n');
  const chunks = chunkText(doc, { size: 300, overlap: 40 });
  check('长文档被切成多块', chunks.length >= 3, { len: doc.length, chunks: chunks.length });
  check('每块不超过目标长度太多', chunks.every((c) => c.content.length <= 420), chunks.map((c) => c.content.length));
  check('每块都有实际内容', chunks.every((c) => c.content.length >= 30), chunks.map((c) => c.content.length));
  check('序号从 1 连续', chunks.every((c, i) => c.seq === i + 1), chunks.map((c) => c.seq));
  check('第一块带上了标题', chunks[0]?.heading === '第一章 总则', chunks[0]?.heading);
  const joined = chunks.map((c) => c.content).join('');
  check('内容没有丢失（拼接长度不小于原文的 90%）', joined.length >= doc.replace(/\s/g, '').length * 0.9, { joined: joined.length, doc: doc.length });
}
{
  const short = '这是一段很短的说明文字，不到一块的长度。';
  const chunks = chunkText(short);
  check('短文本切成 1 块', chunks.length === 1, chunks.length);
  check('短文本内容完整', chunks[0]?.content === short, chunks[0]?.content);
}
{
  const chunks = chunkText('   \n\n   \n  ');
  check('空白文本返回空数组', chunks.length === 0, chunks);
}
{
  const noPunct = '甲'.repeat(2000);
  const chunks = chunkText(noPunct, { size: 300, overlap: 50 });
  check('无标点超长文本也能切开（不会死循环）', chunks.length >= 3, chunks.length);
  check('无标点文本块长度受控', chunks.every((c) => c.content.length <= 700), chunks.map((c) => c.content.length));
}
{
  const many = Array.from({ length: 50 }, (_, i) => `第${i + 1}段内容，用于验证上限保护是否生效。`).join('\n\n');
  const chunks = chunkText(many, { size: 100, maxChunks: 5 });
  check('maxChunks 上限生效', chunks.length <= 5, chunks.length);
}

/* ------------------------------ 向量 ------------------------------ */

console.log('\n[向量编解码与相似度]');
{
  const v = [0.1, -0.2, 0.3, 0.4];
  const decoded = decodeVector(encodeVector(v));
  check('编解码往返一致', Boolean(decoded) && Math.abs((decoded?.[0] ?? 0) - 0.1) < 1e-6 && Math.abs((decoded?.[3] ?? 0) - 0.4) < 1e-6, decoded && Array.from(decoded));
  check('维度正确', decoded?.length === 4, decoded?.length);
  check('空值返回 null', decodeVector(null) === null);
  check('长度不是 4 的倍数返回 null', decodeVector(new Uint8Array([1, 2, 3])) === null);
  const a = Float32Array.from([1, 0, 0]);
  const b = Float32Array.from([1, 0, 0]);
  const c = Float32Array.from([0, 1, 0]);
  check('相同向量相似度为 1', Math.abs(cosine(a, b) - 1) < 1e-6, cosine(a, b));
  check('正交向量相似度为 0', Math.abs(cosine(a, c)) < 1e-6, cosine(a, c));
  check('零向量不报错且返回 0', cosine(Float32Array.from([0, 0, 0]), a) === 0);
  check('不同维度时按较短长度计算（不崩）', Number.isFinite(cosine(Float32Array.from([1, 0]), a)));
}

/* ------------------------------ OCR 文本清洗 ------------------------------ */

console.log('\n[OCR 文本清洗]');
{
  const raw = '设备验收管理办法\n\n\n  \n一\n到货后三个工作日内组织验收。\n·\n影像资料应当留存。';
  const cleaned = cleanOcrText(raw);
  const lines = cleaned.split('\n');
  check('去掉空行', !lines.some((l) => l.trim() === ''), lines);
  check('去掉只有单字的噪声行', !lines.includes('一'), lines);
  check('去掉只有符号的噪声行', !lines.includes('·'), lines);
  check('保留有意义的行', cleaned.includes('到货后三个工作日内组织验收。'), cleaned);
  check('压缩行内多余空格', cleanOcrText('设  备   验收').includes('设 备 验收'), cleanOcrText('设  备   验收'));
}

/* ------------------------------ 占位符 ------------------------------ */

console.log('\n[占位符渲染]');
{
  const tpl = '单位：{单位名称}，月份：{检查月份}，负责人：{检查人}';
  const hits = scanPlaceholders(tpl);
  check('扫描出全部占位符', hits.length === 3, hits.map((h) => h.name));
  check('顺序正确', hits[0]?.name === '单位名称' && hits[2]?.name === '检查人', hits.map((h) => h.name));
  const rendered = renderText(tpl, { 单位名称: '某某单位', 检查月份: '2026年3月' });
  check('已给的变量被替换', rendered.includes('某某单位') && rendered.includes('2026年3月'), rendered);
  check('未给的变量原样保留（便于发现遗漏）', rendered.includes('{检查人}'), rendered);
  check('keepUnfilled=false 时替换为空', !renderText(tpl, {}, { keepUnfilled: false }).includes('{检查人}'));
  const withDefault = renderText('编制人：{编制人|办公室}', {});
  check('默认值生效', withDefault === '编制人：办公室', withDefault);
  const fallbackUsed = renderText('编制人：{编制人|办公室}', { 编制人: '' });
  check('空串时用默认值', fallbackUsed === '编制人：办公室', fallbackUsed);
  const valueWins = renderText('编制人：{编制人|办公室}', { 编制人: '张工' });
  check('有值时默认值不生效', valueWins === '编制人：张工', valueWins);
  check('缺失变量能列出来', missingVariables(tpl, { 单位名称: 'x' }).length === 2, missingVariables(tpl, { 单位名称: 'x' }));
  check('重复占位符只报一次', scanPlaceholders('{A}{A}').length === 1, scanPlaceholders('{A}{A}').length);
  check('不含花括号的文本不被误改', renderText('普通文本没有占位符', {}) === '普通文本没有占位符');
}

/* ------------------------------ docx XML 替换 ------------------------------ */

console.log('\n[docx 段落级替换]');
{
  // 模拟 Word 把一个占位符拆进多个 run 的情况
  const xml = `<w:p><w:r><w:t>{单</w:t></w:r><w:r><w:t>位名称}</w:t></w:r></w:p>`;
  const out = replaceInXml(xml, { 单位名称: '某某单位' });
  check('跨 run 的占位符能被替换', out.includes('某某单位'), out);
  check('替换后不再残留占位符', !out.includes('{单'), out);
  check('段落结构被保留', (out.match(/<w:p>/g) ?? []).length === 1, out);
}
{
  const xml = `<w:p><w:r><w:t>检查月份：{检查月份}</w:t></w:r></w:p><w:p><w:r><w:t>没有占位符</w:t></w:r></w:p>`;
  const out = replaceInXml(xml, { 检查月份: '2026年3月' });
  check('只有含占位符的段落被改写', out.includes('2026年3月') && out.includes('没有占位符'), out);
}
{
  const xml = `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>{标题}</w:t></w:r></w:p>`;
  const out = replaceInXml(xml, { 标题: '月度安全检查记录表' });
  check('pPr 与 rPr 格式保留', out.includes('<w:jc w:val="center"/>') && out.includes('<w:b/>'), out);
  check('替换结果正确', out.includes('月度安全检查记录表'), out);
}
{
  const xml = `<w:p><w:r><w:t>未给值：{缺失项}</w:t></w:r></w:p>`;
  const out = replaceInXml(xml, {});
  check('未给值的占位符原样保留', out.includes('{缺失项}'), out);
}

/* ------------------------------ 命名规范 ------------------------------ */

console.log('\n[命名与路径安全]');
{
  check('文件名去掉 Windows 非法字符', !/[\\/:*?"<>|]/.test(safeName('a/b:c*d?e"f<g>h|i')), safeName('a/b:c*d?e"f<g>h|i'));
  check('空名称有兜底', safeName('   ') === '未命名', safeName('   '));
  check('保留中文与括号', safeName('2026年3月 安全检查（一）') === '2026年3月 安全检查（一）', safeName('2026年3月 安全检查（一）'));
  check('超长名被截断', safeName('长'.repeat(300)).length <= 120, safeName('长'.repeat(300)).length);
  const wb = workbenchFolderName('2026-P-001', '某局机房改造');
  check('工作台目录名符合规范', /^[a-f0-9]{16}-2026-P-001-某局机房改造$/.test(wb), wb);
  const gen = generatedFileName('月度安全检查记录表', 'docx', new Date(2026, 2, 15, 10, 30, 0), 1);
  check('生成文件名含日期与版本', /^20260315103000_月度安全检查记录表_v1\.docx$/.test(gen), gen);
  const evi = evidenceFileName('02_到货与开箱', 3, '设备铭牌序列号', '.jpg', new Date(2026, 2, 15, 9, 0, 0));
  check('影像文件名符合规范', /^20260315090000_02_到货与开箱_003_设备铭牌序列号\.jpg$/.test(evi), evi);
}
{
  const root = process.env.WORKBENCH_ISOLATION_ROOT!;
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'sub', 'a.txt'), 'x');
  check('正常相对路径可解析', resolveInside(root, 'sub/a.txt').startsWith(root), resolveInside(root, 'sub/a.txt'));
  let threw = false;
  try {
    resolveInside(root, '../../windows/win.ini');
  } catch {
    threw = true;
  }
  check('目录穿越被拒绝', threw);
  const f1 = uniqueFileName(join(root, 'sub'), 'a.txt');
  check('同名文件自动加版本号', f1 === 'a_v2.txt', f1);
  const f2 = uniqueFileName(join(root, 'sub'), 'b.txt');
  check('不重名时保持原名', f2 === 'b.txt', f2);
}

/* ------------------------------ 检索查询组装 ------------------------------ */

console.log('\n[全文检索查询组装]');
{
  check('中文逐字切分', segCJK('验收清单') === '验 收 清 单', segCJK('验收清单'));
  check('中英混合处理正确', segCJK('验收OK') === '验 收 OK', segCJK('验收OK'));
  const m = buildMatch('验收 资料');
  check('多词用 OR 连接', m === '"验 收" OR "资 料"', m);
  const mAnd = buildMatch('验收 资料', 'and');
  check('and 模式用 AND 连接', mAnd === '"验 收" AND "资 料"', mAnd);
  const mBad = buildMatch('a"b*c(d)');
  check('危险字符被清理（不会让 FTS5 报语法错）', !/["*()]/.test(mBad.replace(/"/g, '')) , mBad);
  check('空查询返回空串', buildMatch('   ') === '', buildMatch('   '));
}

/* ------------------------------ 模型 JSON 容错 ------------------------------ */

console.log('\n[模型返回 JSON 容错解析]');
{
  check('纯 JSON 可解析', parseJsonLoose('{"a":1}').ok, parseJsonLoose('{"a":1}'));
  check('带 ```json 围栏可解析', parseJsonLoose('```json\n{"a":1}\n```').ok);
  check('前后有解释文字可解析', parseJsonLoose('好的，结果如下：{"a":1} 以上。').ok, parseJsonLoose('好的，结果如下：{"a":1} 以上。'));
  check('嵌套对象可解析', (parseJsonLoose<{ a: { b: number } }>('{"a":{"b":2}}').value?.a?.b ?? 0) === 2);
  check('数组可解析', parseJsonLoose('[1,2]').ok);
  check('含花括号的字符串值不会截断错误', (parseJsonLoose<{ s: string }>('{"s":"含}花括号"}').value?.s ?? '') === '含}花括号', parseJsonLoose('{"s":"含}花括号"}'));
  check('非 JSON 返回失败并带说明', parseJsonLoose('这不是 JSON').ok === false);
}

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
if (fail > 0) process.exitCode = 1;
