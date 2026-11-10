// Default: build and run the checked-out source. Historical packages are explicit recovery only.
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('需要 Node.js 24 或更高版本（含 npm），请安装后重新双击启动。');
  process.exitCode = 1;
} else {
  try { await import(process.argv.includes('--release') ? './start-release.mjs' : './start-source.mjs'); }
  catch (error) { console.error(`启动未完成：${error.message}`); process.exitCode = 1; }
}
