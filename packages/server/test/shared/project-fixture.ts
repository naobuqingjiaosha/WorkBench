import {randomUUID} from 'node:crypto';
import {createConfigType, previewConfig, publishConfig, saveConfigDraft} from '../../src/domain/workflow-config.ts';
import type {ConfigState} from '../../src/domain/workflow-config-types.ts';

export function publishProject(state: ConfigState) {
  const draft = saveConfigDraft(state.typeId, {revision:state.revision,baseVersionId:state.baseVersionId,payload:state.payload});
  const expected={revision:draft.revision,baseVersionId:draft.baseVersionId};
  const preview=previewConfig(draft.typeId, expected);
  return publishConfig(draft.typeId, {...expected, previewDigest:preview.digest, note:'合成项目配置',operationId:randomUUID()});
}

export function projectFixture() {
  const draft=createConfigType({code:'synthetic-project',name:'合成实施流程',navigationGroup:'information'});
  draft.payload.stages=[{code:'accept',name:'交付核验',seq:1,folder_name:null,period_dir:null,description:'核对外部交付材料',duration_hint:null,
    materials:[{key:'receipt',name:'交付证明',category:'material',kind:'external',required:1,template_id:null,retention:null,hint:'核对原件'}],
    evidences:[], documents:[]}];
  return publishProject(draft);
}
