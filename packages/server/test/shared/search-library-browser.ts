import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {withBrowserPage} from './browser-fixture.ts';

async function readData<T>(response:Response):Promise<T> {
  const result = await response.json() as {ok:true;data:T}|{ok:false;error:{message:string}};
  assert.ok(result.ok, result.ok ? response.statusText : result.error.message);
  assert.ok(response.ok,response.statusText);
  return result.data;
}

await withBrowserPage(async (page, base) => {
  const {token} = await readData<{token:string}>(await fetch(base+'/api/session'));
  const query = '晨星合成';
  const templates: number[] = [], files: number[] = [];
  const sizes = [[1366,768],[390,844]] as const;
  async function upload<T>(path: string, form: FormData) {
    const response = await fetch(base+path, {method:'POST', headers:{'x-workbench-token':token}, body:form});
    const {items} = await readData<{items:T[]}>(response);
    const item = items[0];
    assert.ok(item,'上传响应缺少记录');
    return item;
  }
  for (const label of ['甲','乙']) {
    const book = new ExcelJS.Workbook();
    book.addWorksheet('合成表格').addRow(['固定表头'+label]);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(await book.xlsx.writeBuffer())]), query+'模板'+label+'.xlsx');
    templates.push((await upload<{template:{id:number}}>('/api/templates/upload', form)).template.id);
    const attachment = new FormData();
    attachment.append('file',new Blob(['合成附件正文'+label]),query+'文件'+label+'.txt');
    files.push((await upload<{id:number}>('/api/artifacts/upload',attachment)).id);
  }

  const {items:types} = await readData<{items:{id:number;domain:string;published_config_id:number|null}[]}>(await fetch(base+'/api/work-types'));
  const project = types.find(t=>t.domain==='project'&&t.published_config_id);
  assert.ok(project);
  for(let n=1;n<=6;n++) {
    const response = await fetch(base+'/api/workbenches',{method:'POST',headers:{'content-type':'application/json','x-workbench-token':token},
      body:JSON.stringify({workTypeId:project.id,publishedConfigId:project.published_config_id,name:'合成截止项目'+n,planEndDate:'2028-11-1'+n})});
    assert.ok(response.ok,(await response.text()).slice(0,250));
  }
  await page.goto(base+'/#/dashboard');
  const button = (name:string) => page.getByRole('button',{name,exact:true});
  const quickRecord = page.locator('.home-header-actions').getByRole('button',{name:'随手记'});
  for (const [width,height] of sizes) {
    await page.setViewportSize({width,height});
    const deadlinePanel = page.locator('.home-deadlines');
    const expand = deadlinePanel.getByRole('button',{name:'查看全部 6 项截止'});
    await expand.waitFor();
    const rows = deadlinePanel.locator('.home-deadline-list li');
    assert.equal(await rows.count(),width===390?5:2);
    const rowBox=await rows.first().boundingBox();
    assert.ok(rowBox&&rowBox.height<=65,'短名称的日期、工作与类型应为紧凑行');
    await expand.click();
    const schedule=page.getByRole('dialog',{name:'全部截止安排'});
    assert.equal(await schedule.locator('.home-deadline-list li').count(),6);
    await page.keyboard.press('Escape');
    assert.equal(await expand.evaluate((el:Element)=>el===document.activeElement),true);
    await page.locator('.content').evaluate((el:Element)=>el.scrollTo({top:0}));
    const box = await quickRecord.boundingBox();
    assert.ok(box && box.y >= 0 && box.y+box.height <= height);
  }
  await quickRecord.click();
  await page.waitForURL(/#\/records$/);
  await page.goto(base+'/#/dashboard');
  await button('搜索工作、成果、模板').click();
  const search = page.getByRole('dialog',{name:'搜索工作、成果、模板'});
  const input = search.getByRole('textbox');
  await input.fill(query);
  await search.getByText(/在 .* 个范围里搜/).waitFor();
  const fileRoute = '#/files?artifact='+files[0];
  const templateRoute = '#/knowledge?module=template&templateId='+templates[0];
  for (const [href,title] of [[fileRoute,'预览：'+query+'文件甲.txt'],[templateRoute,'模板预览与核对：'+query+'模板甲']]) {
    const hit = search.locator('a[href="'+href+'"]');
    await hit.click();
    await page.getByRole('dialog',{name:title,exact:true}).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(),1);
    assert.equal(await input.inputValue(),query);
    assert.equal(await hit.evaluate((el:Element)=>document.activeElement===el),true);
    assert.ok(await search.locator('a[href="#/files?artifact='+files[1]+'"]').isVisible());
    assert.ok(await search.locator('a[href="#/knowledge?module=template&templateId='+templates[1]+'"]').isVisible());
  }

  await page.goto(base+'/'+fileRoute);
  await page.getByRole('dialog',{name:'预览：'+query+'文件甲.txt'}).getByText('合成附件正文甲',{exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForURL(/#\/files$/);
  const filters = page.locator('.file-search-inputs');
  for (const [width,height] of sizes) {
    await page.setViewportSize({width,height});
    const text = await filters.getByRole('textbox').boundingBox(), mode = await filters.getByRole('combobox').boundingBox();
    assert.ok(text && mode && text.width > mode.width);
    if(width===390) assert.ok(mode.y >= text.y+text.height);
  }
  await page.getByRole('columnheader',{name:'大小',exact:true}).waitFor();
  await button('前往模板库 →').click();
  await page.waitForURL(/#\/knowledge\?module=template$/);
  await page.goto(base+'/'+templateRoute);
  await page.getByRole('dialog',{name:'模板预览与核对：'+query+'模板甲'}).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForURL(/#\/knowledge\?module=template$/);
  const row = page.getByRole('row').filter({hasText:query+'模板甲'});
  await row.getByText('0 个',{exact:true}).waitFor();
  await page.getByPlaceholder('搜模板名').fill('无匹配合成名称');
  await page.getByText('当前目录或关键词下没有匹配的模板。').waitFor();
  assert.equal(await page.getByRole('button',{name:/上传.*模板/}).count(),1);
  await button('清除筛选').click();
  await button('查看归档').click();
  await page.getByText('暂无已归档的模板。').waitFor();
  await button('返回在用模板').click();
  await row.getByRole('button').click();
  await page.locator('.template-details').getByRole('button',{name:'归档',exact:true}).click();
  await button('确认归档').click();
  await row.waitFor({state:'hidden'});
  await button('查看归档').click();
  await row.getByRole('button').click();
  await page.locator('.template-details').getByRole('button',{name:'恢复',exact:true}).click();
  await page.getByText('暂无已归档的模板。').waitFor();
  await button('字段映射').click();
  await page.getByText(/未映射变量（0 个名字/).waitFor();
  assert.equal(await page.getByRole('button',{name:/显示更多/}).count(),0);
  console.log('首页随手记与搜索、文件和模板命中预览及返回、深链、搜索控件尺寸、归档和零变量状态通过');
});
