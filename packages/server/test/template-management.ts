/** 模板替换、删除及恢复的隔离接口回归测试。 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import ExcelJS from 'exceljs';
import PizZip from 'pizzip';

const parent = resolve('.tmp');
mkdirSync(parent, { recursive: true });
const tmp = process.env.WORKBENCH_ISOLATION_ROOT!;


process.env.WORKBENCH_TEST_MODE = '1';
const { initDatabase, closeDatabase, run, all } = await import('../src/db/index.ts');
const { ensureBaseDirs } = await import('../src/core/config.ts');
const service = await import('../src/domain/service.ts');
const { registerTemplateRoutes } = await import('../src/api/routes-template.ts');
const app = Fastify();
await app.register(multipart);
registerTemplateRoutes(app);
let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log('✓ ' + name); };
async function spreadsheet(text: string) {
  const book = new ExcelJS.Workbook();
  book.addWorksheet('模板').getCell('A1').value = text;
  return Buffer.from(await book.xlsx.writeBuffer());
}
async function upload(id: number, files: { name: string; bytes: Buffer }[]) {
  const boundary = 'template-test-boundary';
  const payload = Buffer.concat([
    ...files.flatMap(f => [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), f.bytes, Buffer.from('\r\n')]),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  return app.inject({ method: 'POST', url: `/api/templates/${id}/reupload`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
}
try {
  initDatabase(process.env.WORKBENCH_DB!);
  ensureBaseDirs();
  const source = join(tmp, 'original.xlsx');
  const original = await spreadsheet('{单位名称} {旧变量}');
  writeFileSync(source, original);
  const t = service.registerTemplate({ absSourcePath: source, name: '测试模板', category: 'admin', description: '保留说明' });
  service.writeTemplateVars(t, { description: '变量说明', variables: [{ name: '单位名称', label: '单位全称', required: false, hint: '保留提示' }, { name: '旧变量' }] });
  const oldPath = service.templateAbsPath(t);
  const replacement = await spreadsheet('{单位名称} {新变量}');
  const result = await upload(t.id, [{ name: 'updated.xlsx', bytes: replacement }]);
  assert.equal(result.statusCode, 200, result.body);
  const fresh = service.getTemplate(t.id)!;
  check('替换保留模板身份、名称、类别和说明', () => {
    assert.equal(fresh.id, t.id); assert.equal(fresh.code, t.code); assert.equal(fresh.name, t.name);
    assert.equal(fresh.category, t.category); assert.equal(fresh.description, t.description);
    assert.equal(all('SELECT id FROM template').length, 1);
  });
  check('新文件生效，原文件仍保留', () => {
    assert.deepEqual(readFileSync(service.templateAbsPath(fresh)), replacement);
    assert.deepEqual(readFileSync(oldPath), original);
    assert.equal(fresh.health_ok, 1);
  });
  check('重新扫描变量，保留同名变量填写说明', () => {
    const vars = service.readTemplateVars(fresh);
    assert.deepEqual(vars.variables.map(v => v.name), ['单位名称', '新变量']);
    assert.equal(vars.variables[0]?.label, '单位全称'); assert.equal(vars.variables[0]?.required, false);
    assert.equal(vars.description, '变量说明'); assert.equal(fresh.variable_count, 2);
  });
  const invalid = await upload(t.id, [{ name: 'broken.xlsx', bytes: Buffer.from('broken') }]);
  const wrongType = await upload(t.id, [{ name: 'wrong.txt', bytes: Buffer.from('text') }]);
  const multiple = await upload(t.id, [{ name: 'one.xlsx', bytes: replacement }, { name: 'two.xlsx', bytes: replacement }]);
  check('损坏文件、错误格式和多文件均拒绝，当前模板不变', () => {
    for (const response of [invalid, wrongType, multiple]) assert.equal(response.statusCode, 400, response.body);
    assert.equal(service.getTemplate(t.id)?.file_rel, fresh.file_rel);
    assert.deepEqual(readFileSync(service.templateAbsPath(fresh)), replacement);
  });
  const inspect = await app.inject(`/api/templates/${t.id}/preview`);
  assert.equal(inspect.statusCode, 200, inspect.body);
  check('预览显示变量原文、Excel 单元格位置和当前文件体检结果', () => {
    const data = inspect.json().data;
    assert.equal(data.health.ok, true); assert.match(data.scan.preview, /\{单位名称\}/);
    assert.equal(data.scan.locations[0].location, '模板!A1');
    assert.deepEqual(data.added, []); assert.deepEqual(data.removed, []);
  });
  const logsBefore = all('SELECT id FROM generation_log').length;
  const trial = await app.inject({ method: 'POST', url: `/api/templates/${t.id}/preview`, payload: { values: { 单位名称: '预览单位' } } });
  assert.equal(trial.statusCode, 200, trial.body);
  check('试填显示实际替换结果和未填变量，不生成正式记录', () => {
    const data = trial.json().data;
    assert.equal(data.check.ok, true); assert.deepEqual(data.missing, ['新变量']);
    assert.match(JSON.stringify(data.plan.segments), /预览单位/);
    assert.equal(all('SELECT id FROM generation_log').length, logsBefore);
    assert.deepEqual(service.readTemplateVars(fresh).variables.map(v => v.name), ['单位名称', '新变量']);
  });
  const download = await app.inject({ method: 'POST', url: `/api/templates/${t.id}/preview`, payload: { download: true, values: { 单位名称: '下载单位', 新变量: '下载值' } } });
  assert.equal(download.statusCode, 200, download.body);
  const outputBook = new ExcelJS.Workbook();
  await outputBook.xlsx.load(Uint8Array.from(download.rawPayload).buffer);
  check('下载的试填文件可打开且包含实际测试值', () => assert.equal(outputBook.worksheets[0]?.getCell('A1').value, '下载单位 下载值'));
  const mergedBook = new ExcelJS.Workbook();
  const mergedSheet = mergedBook.addWorksheet('合并表');
  mergedSheet.mergeCells('A1:C1');
  mergedSheet.getCell('A1').value = '合并区域：{单位名称}';
  writeFileSync(service.templateAbsPath(fresh), Buffer.from(await mergedBook.xlsx.writeBuffer()));
  const mergedInspect = (await app.inject(`/api/templates/${t.id}/preview`)).json().data;
  const mergedTrial = (await app.inject({ method: 'POST', url: `/api/templates/${t.id}/preview`, payload: { values: { 单位名称: '合并测试值' } } })).json().data;
  check('Excel 合并单元格不会重复识别，试填表格保留行列坐标', () => {
    assert.equal(mergedInspect.scan.locations.length, 1);
    assert.equal(mergedInspect.scan.locations[0].location, '合并表!A1');
    assert.deepEqual(mergedTrial.plan.segments[0].headers, ['行号', 'A', 'B', 'C']);
    assert.deepEqual(mergedTrial.plan.segments[0].rows[0], ['1', '合并区域：合并测试值', '', '']);
  });
  writeFileSync(service.templateAbsPath(fresh), await spreadsheet('x'.repeat(8100) + '{摘要外变量}'));
  const changed = (await app.inject(`/api/templates/${t.id}/preview`)).json().data;
  check('摘要截断会标注，摘要外变量有位置记录，并提示识别清单过期', () => {
    assert.equal(changed.scan.previewTruncated, true);
    assert.ok(changed.scan.locations.some((p: { name: string }) => p.name === '摘要外变量'));
    assert.deepEqual(changed.added, ['摘要外变量']); assert.deepEqual(changed.removed, ['单位名称', '新变量']);
  });
  writeFileSync(service.templateAbsPath(fresh), 'damaged');
  const badInspect = (await app.inject(`/api/templates/${t.id}/preview`)).json().data;
  const badTrial = await app.inject({ method: 'POST', url: `/api/templates/${t.id}/preview`, payload: { values: {} } });
  check('实时检查损坏文件，不能因旧的健康标记而误报通过', () => {
    assert.equal(badInspect.health.ok, false); assert.equal(badTrial.statusCode, 400);
  });
  writeFileSync(service.templateAbsPath(fresh), replacement);
  const doczip = new PizZip();
  const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  doczip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  doczip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p('单位：{单位名称}')}<w:tbl><w:tr><w:tc>${p('名称')}</w:tc></w:tr><w:tr><w:tc>${p('{#循环 材料清单}{名称}{/循环}')}</w:tc></w:tr></w:tbl>${p('{@图片 现场照片}')}</w:body></w:document>`);
  doczip.file('word/header1.xml', `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${p('编号：{文号}')}</w:hdr>`);
  const docSource = join(tmp, 'source.docx');
  writeFileSync(docSource, doczip.generate({ type: 'nodebuffer' }));
  const doc = service.registerTemplate({ absSourcePath: docSource, name: 'Word核对' });
  const docInspect = (await app.inject(`/api/templates/${doc.id}/preview`)).json().data;
  check('Word 预览识别页眉、正文、循环字段和图片占位', () => {
    assert.ok(docInspect.scan.locations.some((p: { name: string; location: string }) => p.name === '文号' && p.location.startsWith('页眉')));
    assert.deepEqual(docInspect.structure.collections[0].fields, ['名称']);
    assert.equal(docInspect.structure.images[0].name, '现场照片');
  });
  const docTrial = await app.inject({ method: 'POST', url: `/api/templates/${doc.id}/preview`, payload: { values: { 单位名称: '测试单位', 文号: '测试001', 材料清单: [{ 名称: '材料甲' }, { 名称: '材料乙' }] } } });
  assert.equal(docTrial.statusCode, 200, docTrial.body);
  check('Word 实际渲染循环，缺少工作台图片会明确提示', () => {
    const data = docTrial.json().data;
    assert.equal(data.check.ok, true);
    assert.match(JSON.stringify(data.plan.segments), /材料甲/); assert.match(JSON.stringify(data.plan.segments), /材料乙/);
    assert.ok(data.missingImages.length > 0);
  });
  await app.inject({ method: 'DELETE', url: `/api/templates/${doc.id}/permanent` });
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/templates/${t.id}` })).statusCode, 200);
  check('删除移入归档，在用列表隐藏', () => {
    assert.ok(service.getTemplate(t.id)?.archived_at);
    assert.equal(service.listTemplates().length, 0);
    assert.equal(service.listTemplates({ archived: true }).length, 1);
  });
  const archivedUpload = await upload(t.id, [{ name: 'archived.xlsx', bytes: replacement }]);
  assert.equal(archivedUpload.statusCode, 200, archivedUpload.body);
  check('归档模板可重传且不会自动恢复', () => assert.ok(service.getTemplate(t.id)?.archived_at));
  assert.equal((await app.inject({ method: 'POST', url: `/api/templates/${t.id}/unarchive` })).statusCode, 200);
  check('恢复后文件可读取', () => {
    assert.equal(service.getTemplate(t.id)?.archived_at, null);
    assert.ok(existsSync(service.templateAbsPath(service.getTemplate(t.id)!)));
  });
  run('INSERT INTO generation_log(template_id) VALUES(?)', [t.id]);
  const inUse = await app.inject({ method: 'DELETE', url: `/api/templates/${t.id}/permanent` });
  check('有生成历史的模板阻止彻底删除', () => {
    assert.equal(inUse.statusCode, 400, inUse.body); assert.ok(service.getTemplate(t.id));
  });
  const missing = service.registerTemplate({ absSourcePath: source, name: '缺失模板' });
  rmSync(service.templateAbsPath(missing));
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/templates/${missing.id}` })).statusCode, 200);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/templates/${missing.id}/permanent` })).statusCode, 200);
  check('文件丢失的模板也能删除，未使用模板可彻底删除', () => assert.equal(service.getTemplate(missing.id), undefined));
  check('外键完整性正常', () => assert.deepEqual(all('PRAGMA foreign_key_check'), []));
  console.log(`模板管理回归：${passed} 项通过`);
} finally {
  await app.close();
  closeDatabase();
  // The parent launcher validates and removes its own isolated root.
}
