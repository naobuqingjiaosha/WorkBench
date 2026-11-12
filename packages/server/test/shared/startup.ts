import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const pkg=JSON.parse(readFileSync('package.json','utf8'));
assert.equal(pkg.scripts.start,'node scripts/start.mjs');
assert.equal(pkg.scripts['start:auto'],'node scripts/start.mjs --auto');
assert.equal(pkg.scripts['preview:candidate'],undefined);
assert.equal(existsSync('预览候选工作台.cmd'),false);
assert.equal(existsSync('scripts/start-release.mjs'),false);
for(const entry of ['scripts/start.mjs','scripts/start-source.mjs']){
 for(const retired of ['--release','--last-good']){
  const run=spawnSync(process.execPath,[entry,retired],{encoding:'utf8'});
  assert.equal(run.status,1);
  assert.match(run.stderr,/旧版启动参数已移除/);
 }
}
const launcher=readFileSync('启动工作台.cmd','utf8');
assert.ok(launcher.includes('scripts\\start.mjs'));
assert.match(launcher,/scripts\\start\.mjs" --desktop --open/);
assert.ok(!launcher.includes('--confirm-update'));
await import('../../../../scripts/esbuild-transport.mjs');
const {transform}=await import('esbuild');
const result=await transform('/*'+'x'.repeat(1024*1024)+'*/const ok: boolean=true',{loader:'ts'});
assert.match(result.code,/const ok = true/);
console.log('启动专项：唯一双击入口、npm同链、保留确认、大文件esbuild传输通过（非日常启动验收）');
