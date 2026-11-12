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
    const {token}=await get('/api/session');
    for(let i=1;i<=32;i++){
        const response=await fetch(base+'/api/work-records',{method:'POST',
            headers:{'Content-Type':'application/json','x-workbench-token':token},
            body:JSON.stringify({text:'长列表定位样例 '+i,request_key:crypto.randomUUID()})});
        assert.ok(response.ok);
    }
    await page.reload();
    const rows=page.locator('article');
    await rows.nth(29).waitFor({state:'attached'});
    const opener=rows.first().getByRole('button',{name:'查看来源与历史'});
    await opener.scrollIntoViewIfNeeded();
    const origin=await page.locator('.content').evaluate((e:HTMLElement)=>e.scrollTop);
    await opener.click();
    const historyDialog=page.getByRole('dialog',{name:/来源与更正历史/});
    await historyDialog.waitFor();
    const bounds=await historyDialog.boundingBox();
    assert.ok(bounds && bounds.y>=0 && bounds.y+bounds.height<=page.viewportSize().height+1);
    assert.equal(await historyDialog.getByRole('button',{name:'查看来源与历史'}).count(),0);
    await historyDialog.getByRole('button',{name:'关闭详情'}).click();
    assert.equal(await opener.evaluate((e:Element)=>document.activeElement===e),true);
    assert.ok(Math.abs(await page.locator('.content').evaluate((e:HTMLElement)=>e.scrollTop)-origin)<=2);
    const composer=page.getByLabel('做了什么，直接说');
    await composer.fill('另一个编辑区尚未保存的工作记录');
    await rows.first().getByRole('button',{name:'更正'}).click();
    await page.getByLabel('原话／更正内容').fill('单独取消这项更正');
    await page.keyboard.press('Escape');
    await button('不保存离开').click();
    assert.equal(await composer.inputValue(),'另一个编辑区尚未保存的工作记录');
    console.log('真实 Chromium 核对工作记录保存、更正、撤回、长列表就地查看历史及关闭后恢复焦点和滚动。');
});
