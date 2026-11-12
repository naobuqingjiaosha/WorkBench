/** Build-only compatibility adapter for the locked esbuild 0.28.2 Node API.
 * Its >1 MiB input shortcut asks the native service to read AND remove a temp
 * file before transforming. Windows can reject that removal. Keep the normal
 * stdin/stdout protocol for every size instead; compiler options are unchanged.
 * No installed files, fs APIs, permissions or native binaries are modified.
 * Re-review this adapter when upgrading esbuild; unknown source fails closed.
 * Upstream: evanw/esbuild v0.28.2 lib/shared/common.ts (transform) and
 * cmd/esbuild/service.go (handleTransformRequest).
 */
import {createHash} from 'node:crypto';
import {createRequire,registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

// Resolve against the build being checked.
const require=createRequire(join(process.cwd(),'package.json'));
const entry=require.resolve('esbuild');
if(createRequire(require.resolve('vite/package.json')).resolve('esbuild')!==entry){
 throw Error('Vite与预检使用了不同的esbuild，停止构建并复核锁文件。');
}
const source=readFileSync(entry,'utf8');
const expected='61ec0ba144ff93f4bf0e96ad6fab6f430ede0aa13e27ace8063ed63ba416b3cd';
const shortcut='if ((typeof input === "string" || input instanceof Uint8Array) && input.length > 1024 * 1024) {';
if(createHash('sha256').update(source).digest('hex')!==expected || source.split(shortcut).length!==2){
 throw Error('esbuild传输适配与锁定源码不匹配；请复核依赖和适配器，停止构建，不回退临时文件通道。');
}
if(require.cache[entry])throw Error('esbuild已先于传输适配加载，拒绝未经适配的构建。');
const entryURL=pathToFileURL(entry).href;
registerHooks({
 load(url,context,nextLoad){
  if(url!==entryURL)return nextLoad(url,context);
  return {format:'commonjs',source:source.replace(shortcut,'if (false) { // WorkBench: use the existing stdio transport'),shortCircuit:true};
 },
});
