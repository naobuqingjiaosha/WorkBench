/**
 * 生成两个可直接使用的示例模板（真实 .docx 文件），并登记进模板库。
 *
 *   node packages/server/src/cli/make-samples.ts
 *
 * 生成位置：data/files/_模板库/
 * 你可以直接用 Word 打开它们，照着这个格式把你自己的模板改造成模板。
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import PizZip from 'pizzip';
import { bootstrap } from '../core/bootstrap.ts';
import { DATA_ROOT, DIRS } from '../core/config.ts';
import { ensureDir } from '../core/paths.ts';
import { rescanTemplate, upsertWorkType } from '../domain/service.ts';
import { registerTemplate } from '../domain/service.ts';
import { get, run } from '../db/index.ts';

bootstrap();

/* ------------------------------ docx 组装 ------------------------------ */

interface Para {
  text: string;
  bold?: boolean;
  size?: number;
  align?: 'left' | 'center' | 'right';
  spacing?: boolean;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 把文本转成 WordprocessingML 段落；支持 \t 制表 与 | 分栏 */
function para(p: Para): string {
  const sz = p.size ?? 21; // 半磅：21 = 10.5pt 五号
  const jc = p.align ? `<w:jc w:val="${p.align}"/>` : '';
  const b = p.bold ? '<w:b/><w:bCs/>' : '';
  const sp = p.spacing ? '<w:spacing w:before="120" w:after="120"/>' : '';
  const runs = p.text
    .split('\t')
    .map((seg, i) => `${i > 0 ? '<w:r><w:tab/></w:r>' : ''}<w:r><w:rPr>${b}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr><w:t xml:space="preserve">${esc(seg)}</w:t></w:r>`)
    .join('');
  return `<w:p><w:pPr>${sp}${jc}<w:rPr>${b}<w:sz w:val="${sz}"/></w:rPr></w:pPr>${runs}</w:p>`;
}

function makeDocx(paras: Para[], landscape = false): Buffer {
  const zip = new PizZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
  );
  zip.folder('_rels')!.file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.folder('word')!.file(
    '_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );
  zip.folder('word')!.file(
    'styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="仿宋_GB2312" w:hAnsi="Times New Roman"/><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:line="360" w:lineRule="auto"/></w:pPr></w:style>
</w:styles>`,
  );

  const sectPr = landscape
    ? '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1418"/></w:sectPr>'
    : '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1418" w:bottom="1440" w:left="1587"/></w:sectPr>';

  zip.folder('word')!.file(
    'document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${paras.map(para).join('')}${sectPr}</w:body>
</w:document>`,
  );
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}

/* ------------------------------ 表格型记录表 ------------------------------ */

/** 用制表符 + 下划线模拟表格（保证模板结构简单、变量一定在同一段落内，填充最可靠） */
function line(label: string, value: string, width = 30): Para {
  return { text: `${label}：${value}`, size: 21, spacing: true };
}

const TEMPLATE_DIR = join(DATA_ROOT, DIRS.templates);
ensureDir(TEMPLATE_DIR);
// 先写到临时目录，再交给 registerTemplate 复制进模板库；
// 否则源文件已存在于 _模板库 会导致生成 _v2 副本。
const STAGE_DIR = join(DATA_ROOT, DIRS.inbox);
ensureDir(STAGE_DIR);

/* ---------- 模板一：行政管理 · 月度安全检查记录表 ---------- */

const adminParas: Para[] = [
  { text: '{单位名称}', size: 32, bold: true, align: 'center', spacing: true },
  { text: '月度安全检查记录表', size: 32, bold: true, align: 'center', spacing: true },
  { text: '', size: 21 },
  line('检查月份', '{检查月份}'),
  line('检查区域', '{检查区域}'),
  line('检查依据', '{检查依据}'),
  line('检查人', '{检查人}'),
  line('检查日期', '{检查日期}'),
  { text: '', size: 21 },
  { text: '一、检查情况', size: 24, bold: true, spacing: true },
  { text: '{检查情况}', size: 21 },
  { text: '', size: 21 },
  { text: '二、发现问题及整改要求', size: 24, bold: true, spacing: true },
  { text: '{发现问题}', size: 21 },
  { text: '', size: 21 },
  { text: '三、检查结论', size: 24, bold: true, spacing: true },
  { text: '{检查结论}', size: 21 },
  { text: '', size: 21 },
  { text: '检查人签字：{检查人}\t\t记录人签字：{记录人}', size: 21, spacing: true },
  { text: '分管领导签字：{审批人}\t\t日期：{检查日期}', size: 21, spacing: true },
];

const adminFile = join(STAGE_DIR, '示例_月度安全检查记录表.docx');
writeFileSync(adminFile, makeDocx(adminParas));

/* ---------- 模板二：项目实施 · 开箱验收记录表 ---------- */

const projParas: Para[] = [
  { text: '{项目名称}', size: 32, bold: true, align: 'center', spacing: true },
  { text: '设备到货开箱验收记录表', size: 32, bold: true, align: 'center', spacing: true },
  { text: '', size: 21 },
  line('合同编号', '{合同编号}'),
  line('供货单位', '{供货单位}'),
  line('到货日期', '{到货日期}'),
  line('开箱地点', '{开箱地点}'),
  line('参加人员', '{参加人员}'),
  { text: '', size: 21 },
  { text: '一、到货情况', size: 24, bold: true, spacing: true },
  { text: '{到货情况}', size: 21 },
  { text: '', size: 21 },
  { text: '二、开箱清点结果', size: 24, bold: true, spacing: true },
  { text: '{清点结果}', size: 21 },
  { text: '', size: 21 },
  { text: '三、外观检查与随机资料', size: 24, bold: true, spacing: true },
  { text: '{外观检查}', size: 21 },
  { text: '', size: 21 },
  { text: '四、影像证据留存清单', size: 24, bold: true, spacing: true },
  { text: '1. 开箱前外包装（含运单号）：{影像_外包装}', size: 21 },
  { text: '2. 设备铭牌与序列号：{影像_铭牌序列号}', size: 21 },
  { text: '3. 外观全景（正面/侧面）：{影像_外观}', size: 21 },
  { text: '4. 随机附件与资料：{影像_随机资料}', size: 21 },
  { text: '', size: 21 },
  { text: '五、结论', size: 24, bold: true, spacing: true },
  { text: '{验收结论}', size: 21 },
  { text: '', size: 21 },
  { text: '供货方代表：{供货方代表}\t\t收货方代表：{收货方代表}', size: 21, spacing: true },
  { text: '记录日期：{记录日期}', size: 21, spacing: true },
];

const projFile = join(STAGE_DIR, '示例_设备开箱验收记录表.docx');
writeFileSync(projFile, makeDocx(projParas));

/* ---------- 登记进模板库并扫描变量 ---------- */

const adminType = upsertWorkType({ code: 'admin', name: '行政管理', category: '行政管理' });
const projType = upsertWorkType({ code: 'project', name: '项目实施', category: '项目实施' });

/** 先清掉同 code 的旧记录与旧文件，保证重复执行不会堆出 _v2 _v3 副本 */
function purgeSampleTemplate(code: string): void {
  const old = get<{ id: number; file_rel: string; vars_rel: string | null }>(
    'SELECT id, file_rel, vars_rel FROM template WHERE code = ?',
    [code],
  );
  if (!old) return;
  for (const rel of [old.file_rel, old.vars_rel]) {
    if (!rel) continue;
    const abs = join(DATA_ROOT, rel);
    if (existsSync(abs)) {
      try {
        rmSync(abs, { force: true });
      } catch {
        /* 文件被 Word 占用时忽略 */
      }
    }
  }
  run('DELETE FROM material_check WHERE template_id = ?', [old.id]);
  run('DELETE FROM template WHERE id = ?', [old.id]);
}

purgeSampleTemplate('sample-admin-monthly-check');
purgeSampleTemplate('sample-project-unboxing');

const t1 = registerTemplate({
  absSourcePath: adminFile,
  name: '月度安全检查记录表（示例）',
  code: 'sample-admin-monthly-check',
  category: 'admin',
  workTypeId: adminType,
  positionCode: 'A02',
  description: '每月例行安全检查用。变量已用 {中文名} 标出，可直接生成。',
});
const r1 = await rescanTemplate(t1.id);

const t2 = registerTemplate({
  absSourcePath: projFile,
  name: '设备开箱验收记录表（示例）',
  code: 'sample-project-unboxing',
  category: 'project',
  workTypeId: projType,
  positionCode: 'P02',
  description: '设备到货开箱时用，含影像证据留存清单。对应流程阶段「到货与开箱」。',
});
const r2 = await rescanTemplate(t2.id);

// 临时暂存文件已经复制进模板库，删掉暂存副本
for (const f of [adminFile, projFile]) {
  try {
    rmSync(f, { force: true });
  } catch {
    /* 忽略 */
  }
}

console.log('');
console.log('示例模板已生成并登记：');
console.log(`  1. ${adminFile}`);
console.log(`     变量 ${r1.vars.variables.length} 个：${r1.vars.variables.map((v) => v.name).join('、')}`);
console.log(`  2. ${projFile}`);
console.log(`     变量 ${r2.vars.variables.length} 个：${r2.vars.variables.map((v) => v.name).join('、')}`);
console.log('');
console.log('用 Word 打开这两个文件，就能看到模板该怎么写。');
console.log('');
