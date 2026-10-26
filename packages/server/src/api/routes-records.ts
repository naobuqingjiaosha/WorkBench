import type {FastifyInstance} from 'fastify';
import {body,fail,intParam,ok} from './reply.ts';
import {createWorkRecord,changeWorkRecord,searchWorkRecords,requireRecord,recordHistory} from '../domain/work-records.ts';
export function registerRecordRoutes(app:FastifyInstance){
 app.get('/api/work-records',async(req,reply)=>{try{const q=req.query as Record<string,string>;return ok(reply,searchWorkRecords({q:q.q,from:q.from,to:q.to,nature:q.nature,status:q.status,workbenchId:q.workbenchId?Number(q.workbenchId):undefined,page:q.page?Number(q.page):undefined,pageSize:q.pageSize?Number(q.pageSize):undefined}));}catch(e){return fail(reply,e)}});
 app.post('/api/work-records',async(req,reply)=>{try{return ok(reply,createWorkRecord(body(req)),201)}catch(e){return fail(reply,e)}});
 app.get('/api/work-records/:id',async(req,reply)=>{try{return ok(reply,{record:requireRecord(intParam(req,'id')),history:recordHistory(intParam(req,'id'))})}catch(e){return fail(reply,e)}});
 app.put('/api/work-records/:id',async(req,reply)=>{try{return ok(reply,changeWorkRecord(intParam(req,'id'),body(req)))}catch(e){return fail(reply,e)}});
}
