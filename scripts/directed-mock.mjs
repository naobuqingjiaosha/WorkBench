// Offline-only transport. Saved outputs and agent-authored variants are never
// inserted into prompts, and no network call is delegated by this mock.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'..'),src=join(root,'.tmp/directed-offline-2026-10-17/input/real-results');
export const captures=[];
export const state={mode:'original'};
export function modelFixture(payload){
 const name=payload.task?.mode==='report'?'quarter-v1':payload.untrustedEvidence.some(f=>f.kind==='inspection')?'conflict':'complete';
 const prefix={'quarter-v1':'03-quarter-v1',conflict:'02-conflict',complete:'01-complete'}[name];
 const value=JSON.parse(readFileSync(join(src,`${prefix}-writing.model-original.txt`),'utf8'));
 const old=JSON.parse(readFileSync(join(src,`${name}.result.json`))).evidence;
 for(const p of value.paragraphs)for(const c of p.citations){const f=old.facts.find(f=>f.id===c.factId);const next=payload.untrustedEvidence.find(n=>n.text===f?.text||n.bodyText===f?.bodyText&&n.bodyText||n.text.includes(c.quote));if(next)c.factId=next.id;}
 if(name==='quarter-v1'&&state.mode==='success'){
  const suggestions=[['安全','建议围绕已记载的固定件问题补充复查凭证，依据复查结果判断本项处置情况。'],['合同','建议核对合同验收附件缺口，补齐后再判断验收条件是否具备。'],['采购','建议先确认本期采购监督适用范围，再收集相应支持资料。']];
  for(const [topic,text] of suggestions){const p=value.paragraphs.find(p=>p.field.includes(topic)&&p.field.includes('计划'));const f=payload.untrustedEvidence.find(f=>(f.bodyText??f.text).includes(topic)&&!['work','period','metric'].includes(f.kind));p.kind='recommendation';p.text=text;p.citations=[{factId:f.id,quote:f.bodyText??f.text}];}
 }
 return value;
}
export function installMock(){
 if(process.env.WORKBENCH_TEST_MODE!=='1')throw Error('Offline mock requires test isolation');
 const original=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{
  if(!String(url).startsWith('http://127.0.0.1:19027/'))throw Error('Offline transport blocked unexpected URL: '+url);
  const body=JSON.parse(String(init?.body));captures.push(body);
  const payload=JSON.parse(body.messages[1].content),reviewing=body.messages[0].content.includes('逐段审查');
  const content=reviewing?JSON.stringify({reviews:payload.paragraphs.map(p=>({id:p.id,supported:true,reason:'离线模拟复核响应，仅用于流程测试'}))}):JSON.stringify(modelFixture(payload));
  return new Response(JSON.stringify({model:'fake-directed',choices:[{message:{content},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
 };
 return ()=>{globalThis.fetch=original;};
}
export async function configureMock(){
 const p=await import('../packages/server/src/ai/providers.ts');const id=p.upsertProvider({code:'fake-directed',name:'离线模拟传输',base_url:'http://127.0.0.1:19027/v1',enabled:1});
 for(const purpose of ['writing','reasoning'])p.upsertProfile({purpose,name:'离线模拟',provider_id:id,model:'fake-directed',max_tokens:8192});
}
