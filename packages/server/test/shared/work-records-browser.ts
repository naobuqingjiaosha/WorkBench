import assert from 'node:assert/strict';
import {withBrowserPage} from './browser-fixture.ts';

await withBrowserPage(async(page,base)=>{
    const original='合成记录：拟核对两份样表';
    const corrected='合成记录：已核对第一份样表，第二份待核';
    const button=(name:string)=>page.getByRole('button',{name,exact:true});
    const get=async(path:string)=>{
        const response=await fetch(base+path);
        assert.equal(response.status,200);
        return (await response.json()).data;
    };

    await page.goto(base+'/#/dashboard');
    await page.getByRole('button',{name:/随手记/}).click();
    await page.getByLabel('做了什么，直接说').fill(original);
    await page.getByText('补充或指定时间、性质、关联（可不填）',{exact:true}).click();
    await page.getByRole('combobox',{name:/^内容性质/}).selectOption('plan');
    await button('记下来').click();
    await page.getByText(/已保存记录 #\d+ · 发生日期未说明 · 计划/).waitFor();

    const list=await get('/api/work-records');
    assert.equal(list.total,1);
    const first=list.items[0],path='/api/work-records/'+first.id;
    assert.equal(first.text,original);
    assert.equal(first.workbench_id,null);
    assert.equal(first.occurred_from,null);
    assert.equal(first.nature,'plan');
    assert.equal(first.revision,1);

    await page.locator('article').filter({hasText:original}).getByRole('button',{name:'更正',exact:true}).click();
    const dialog=page.getByRole('dialog');
    await dialog.getByLabel('原话／更正内容').fill(corrected);
    await dialog.getByLabel('内容性质（请核对）').selectOption('progress');
    await dialog.getByLabel('发生日期／范围开始').fill('2028-02-29');
    await dialog.getByRole('button',{name:'保存更正',exact:true}).click();
    await dialog.waitFor({state:'hidden'});
    const item=page.locator('article').filter({hasText:corrected});
    await item.getByText(/2028-02-29 · v2/).waitFor();
    await item.getByRole('button',{name:'查看来源与历史'}).click();
    await page.getByText('查看历史版本（不参与当前查询）',{exact:true}).click();
    await page.getByRole('heading',{name:'v1 · 发生日期未说明 · 计划 · 有效'}).waitFor();
    await page.getByText(original,{exact:true}).waitFor();
    await button('关闭详情').click();
    await item.getByRole('button',{name:'撤回',exact:true}).click();
    await page.getByText('符合条件 0 条 · 第1页',{exact:true}).waitFor();
    await page.reload();
    await page.getByText('符合条件 0 条 · 第1页',{exact:true}).waitFor();
    await page.getByLabel('记录范围').selectOption('withdrawn');
    await button('查询记录').click();
    await item.getByRole('button',{name:'恢复',exact:true}).waitFor();
    assert.equal((await get('/api/work-records')).total,0);
    const {record,history}=await get(path);
    assert.equal(record.revision,3);
    assert.equal(record.status,'withdrawn');
    assert.equal(record.workbench_id,null);
    assert.equal(record.occurred_from,'2028-02-29');
    assert.deepEqual(history.map((r:{revision:number;text:string;nature:string;status:string})=>[r.revision,r.text,r.nature,r.status]),
        [[2,corrected,'progress','active'],[1,original,'plan','active']]);
    console.log('真实 Chromium 留存工作原话、日期未知与计划性质；更正另存版本，撤回后仅在撤回范围及历史可查。');
});
