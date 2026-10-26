import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Refuse replacing the frontend underneath an existing daily backend.
const root=resolve(import.meta.dirname,'../..');
const lock=resolve(root,'data/runtime/server.lock');
const outArg=process.argv.indexOf('--outDir');
const output=outArg>=0?resolve(process.cwd(),process.argv[outArg+1]!):resolve(root,'packages/web/dist');
if(process.argv.includes('build')&&output.toLowerCase()===resolve(root,'packages/web/dist').toLowerCase()&&existsSync(lock)){
 const pid=Number(readFileSync(lock,'utf8').trim());let alive=true;
 try{if(!Number.isSafeInteger(pid)||pid<=0)throw Error('无法核实服务锁');process.kill(pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false;else throw e;}
 if(alive)throw Error('日常服务仍在运行，禁止覆盖 dist。请运行 npm run build:staged，取得发布确认后配套切换。');
}
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8787', '/files': 'http://127.0.0.1:8787' },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
