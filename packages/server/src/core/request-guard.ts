import {randomBytes,timingSafeEqual} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {SERVER_PORT} from './config.ts';
export function registerRequestGuard(app:FastifyInstance):void {
 const token=process.env.WORKBENCH_SESSION_TOKEN || randomBytes(32).toString('hex');
 const local=(raw:string):boolean=>{try{const u=new URL(raw);return ['http:','https:'].includes(u.protocol) && ['localhost','127.0.0.1','[::1]'].includes(u.hostname) && [String(SERVER_PORT),'5273'].includes(u.port || (u.protocol==='https:'?'443':'80'));}catch{return false;}};
 app.addHook('onRequest',async(req,reply)=>{
   // A bookmark or external navigation may open the HTML shell. Cross-site API
   // requests still cannot read the session token or any business data.
   const pageNavigation=req.method==='GET' && !req.url.startsWith('/api/') && req.headers['sec-fetch-mode']==='navigate' && req.headers['sec-fetch-dest']==='document';
   if(!local('http://'+req.headers.host) || (req.headers.origin && !local(req.headers.origin)) || (req.headers['sec-fetch-site']==='cross-site'&&!pageNavigation)) return reply.code(403).send({ok:false,error:{code:'UNTRUSTED_ORIGIN',message:'只允许从本机工作台访问'}});
   if(req.url.startsWith('/api/') && !['GET','HEAD','OPTIONS'].includes(req.method)) {
     const value=String(req.headers['x-workbench-token'] ?? '');const a=Buffer.from(value),b=Buffer.from(token);
     if(a.length!==b.length || !timingSafeEqual(a,b))return reply.code(403).send({ok:false,error:{code:'BAD_SESSION',message:'页面会话已过期，请刷新后重试'}});
   }
 });
 app.get('/api/session',async(_req,reply)=>reply.header('Cache-Control','no-store').send({ok:true,data:{token}}));
 app.addHook('onSend',async(_req,reply,payload)=>{reply.header('X-Content-Type-Options','nosniff');return payload;});
}
