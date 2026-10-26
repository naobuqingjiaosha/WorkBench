import {assertTestIsolation} from '../src/core/test-isolation.ts';
import {resolve} from 'node:path';
assertTestIsolation(true);
if(process.env.WORKBENCH_TEST_MODE!=='1' || !process.env.WORKBENCH_TEST_DB || !process.env.BASE)throw new Error('禁止对日常服务执行测试。请使用 npm run test:all 或 npm run test:e2e。');
const original=globalThis.fetch;
const base=new URL(process.env.BASE);
if(base.origin!==`http://127.0.0.1:${process.env.PORT}`||!process.env.WORKBENCH_SESSION_TOKEN)throw Error('测试服务地址或令牌与隔离配置不匹配');
const health=await (await original(base.origin+'/api/health')).json() as {data?:{dbFile?:string}};
if(!health.data?.dbFile||resolve(health.data.dbFile).toLowerCase()!==resolve(process.env.WORKBENCH_DB!).toLowerCase())throw Error('测试服务并未使用指定隔离数据库，拒绝写入请求');
globalThis.fetch=async(input,init)=>{
 const url=String(input instanceof Request?input.url:input);
 const parsed=new URL(url);if(!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname))throw new Error('测试不允许访问外部服务');
 const headers=new Headers(init?.headers);if(parsed.origin===base.origin)headers.set('x-workbench-token',process.env.WORKBENCH_SESSION_TOKEN!);
 return original(input,{...init,headers});
};
