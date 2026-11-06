import {previewWorkflowApplication,applyWorkflowApplication} from '../domain/workflow-application.ts';
import type {FastifyInstance} from 'fastify';
import {body,fail,intParam,ok} from './reply.ts';
import {configState,previewConfig,createConfigType,saveConfigDraft,discardConfigDraft,publishConfig,setConfigAvailability} from '../domain/workflow-config.ts';
export function registerWorkflowConfigRoutes(app:FastifyInstance){
 for(const [suffix,handler] of [['preview',previewWorkflowApplication],['apply',applyWorkflowApplication]] as const) app.post('/api/workbenches/:id/config-'+suffix,async(req,reply)=>{try{return ok(reply,handler(intParam(req,'id'),body(req)));}catch(e){return fail(reply,e);}});
 app.get('/api/workflow-config/:id',async(req,reply)=>{try{return ok(reply,configState(intParam(req,'id')));}catch(e){return fail(reply,e);}});
 app.post('/api/workflow-config',async(req,reply)=>{try{return ok(reply,createConfigType(body(req)),201);}catch(e){return fail(reply,e);}});
 for(const [suffix,handler] of [['preview',previewConfig],['draft',saveConfigDraft],['discard',discardConfigDraft],['publish',publishConfig],['availability',setConfigAvailability]] as const)
 app.post('/api/workflow-config/:id/'+suffix,async(req,reply)=>{try{return ok(reply,handler(intParam(req,'id'),body(req)));}catch(e){return fail(reply,e);}});
}
