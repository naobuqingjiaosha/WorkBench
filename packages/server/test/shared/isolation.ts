import assert from 'node:assert/strict';
import { join } from 'node:path';
import { assertTestIsolation } from '../../src/core/test-isolation.ts';
import { defaultHome, loadRuntimeLayout } from '../../src/core/runtime-layout.ts';
import { cleanRuntimeEnv } from '../../../../scripts/isolation-env.mjs';
import { isShareableFile, contentIssues } from '../../../../scripts/repository-policy.mjs';

const root = process.cwd();
const test = loadRuntimeLayout(root);
const clean = cleanRuntimeEnv({PATH:'synthetic', WORKBENCH_HOME:'private', MODEL_API_KEY:'secret', PORT:'1'});
assert.deepEqual(clean, {PATH:'synthetic'});
assert.equal(test.profile, 'test');
assert.equal(test.configFile, null);
const dev = defaultHome(root, 'development', {XDG_DATA_HOME: test.home});
const daily = defaultHome(root, 'daily', {XDG_DATA_HOME: test.home});
assert.notEqual(dev, daily);
assertTestIsolation(true);
const original = process.env.WORKBENCH_DB;
try {
  process.env.WORKBENCH_DB = join(daily, 'runtime/workbench.db');
  assert.throws(() => assertTestIsolation(true), /越出|必须位于/);
} finally { process.env.WORKBENCH_DB = original; }
assert.equal(isShareableFile('packages/server/test/shared/isolation.ts'), true);
for (const privateFile of ['workbench.config.json','outputs/result.json','packages/server/test/private.ts',
  'packages/server/test/shared/example.xlsx','packages/server/test/shared/fixtures/a.ts','../private.ts']) {
  assert.equal(isShareableFile(privateFile), false, privateFile);
}
assert.ok(contentIssues(Buffer.from([0, 1])).includes('binary-content'));
console.log('隔离验证：环境、路径、凭据与共享用例边界');

assert.ok(contentIssues(Buffer.from(['/Users', 'synthetic', 'folder'].join('/'))).includes('personal-posix-home'));
