import type {FastifyInstance} from 'fastify';
import {body,fail,intParam,ok} from './reply.ts';
import {createDraft,draftContext,draftView,patchDraft,suggestDraft,generateDraft,adoptDraft} from '../domain/inspection-drafts.ts';
export function registerInspectionDraftRoutes(app:FastifyInstance){
 app.get('/api/periods/:id/drafts',async(req,reply)=>{try{return ok(reply,draftContext(intParam(req,'id')));}catch(e){return fail(reply,e);}});
 app.post('/api/periods/:id/drafts',async(req,reply)=>{try{return ok(reply,createDraft(intParam(req,'id'),body(req)),201);}catch(e){return fail(reply,e);}});
 app.get('/api/periods/:id/drafts/:draftId',async(req,reply)=>{try{return ok(reply,draftView(intParam(req,'id'),intParam(req,'draftId')));}catch(e){return fail(reply,e);}});
 app.put('/api/periods/:id/drafts/:draftId',async(req,reply)=>{try{return ok(reply,patchDraft(intParam(req,'id'),intParam(req,'draftId'),body(req)));}catch(e){return fail(reply,e);}});
 app.post('/api/periods/:id/drafts/:draftId/suggest',async(req,reply)=>{try{return ok(reply,await suggestDraft(intParam(req,'id'),intParam(req,'draftId'),body(req)));}catch(e){return fail(reply,e);}});
 app.post('/api/periods/:id/drafts/:draftId/adopt',async(req,reply)=>{try{return ok(reply,adoptDraft(intParam(req,'id'),intParam(req,'draftId'),Number(body(req).revision)));}catch(e){return fail(reply,e);}});
 app.post('/api/periods/:id/drafts/:draftId/generate',async(req,reply)=>{try{return ok(reply,await generateDraft(intParam(req,'id'),intParam(req,'draftId'),body(req)));}catch(e){return fail(reply,e);}});
}
