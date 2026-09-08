import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {clearAppShell} from '../update-utils.js';
const base='https://goodgreatgreat.github.io/4/';
test('更新修復只清本程式快取，保留同來源其他網站和子網站',async()=>{
  const cacheMap=new Map([
    ['slow-notebook-shell-'+base+'v2',[base+'index.html']],
    ['slow-notebook-shell-https://goodgreatgreat.github.io/5/v2',['https://goodgreatgreat.github.io/5/index.html']],
    ['slow-notebook-shell-'+base+'nested/v2',[base+'nested/index.html']],
    ['stock-journal-shell-old',[base+'app.js','https://goodgreatgreat.github.io/5/index.html',base+'nested/app.js']],
    ['unrelated',[base+'saved-document']]
  ]);
  const caches={keys:async()=>[...cacheMap.keys()],delete:async k=>cacheMap.delete(k),open:async k=>({keys:async()=>cacheMap.get(k).map(url=>({url})),delete:async request=>cacheMap.set(k,cacheMap.get(k).filter(url=>url!==request.url))})};
  let unregistered=0;const workers={getRegistrations:async()=>[
    {scope:base,active:{scriptURL:base+'offline.js'},unregister:async()=>unregistered++},
    {scope:'https://goodgreatgreat.github.io/5/',active:{scriptURL:'https://goodgreatgreat.github.io/5/offline.js'},unregister:async()=>{throw Error('touched other site');}},
    {scope:base+'nested/',active:{scriptURL:base+'nested/offline.js'},unregister:async()=>{throw Error('touched nested site');}}
  ]};
  await clearAppShell(base,caches,workers);
  assert.equal(unregistered,1);assert.ok(!cacheMap.has('slow-notebook-shell-'+base+'v2'));
  assert.ok(cacheMap.has('slow-notebook-shell-'+base+'nested/v2'));
  assert.deepEqual(cacheMap.get('stock-journal-shell-old'),['https://goodgreatgreat.github.io/5/index.html',base+'nested/app.js']);
  assert.ok(cacheMap.has('unrelated'));
});
test('修復不需也不使用帳本 localStorage 或 IndexedDB',async()=>{
  const source=await readFile(new URL('../update-utils.js',import.meta.url),'utf8');
  assert.ok(!/localStorage|indexedDB|sessionStorage/.test(source));
  await clearAppShell(base,null,null);
});
test('唯一上傳資料夾包含必需子目錄，首頁没有舊合併按鈕',async()=>{
  for(const path of ['.github/workflows/pages.yml','tools/build.mjs','tools/quotes.mjs','data/taiwan.json','tests/core.test.mjs','update.html','updates.js'])await access(new URL('../'+path,import.meta.url));
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8'),main=await readFile(new URL('../main.js',import.meta.url),'utf8');
  assert.ok(!html.includes('id="merge"'));assert.ok(main.includes('全部帳戶 · 合併檢視'));
  assert.ok(html.includes(JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version));assert.ok(html.includes('id="update-banner"'));
  assert.ok(!main.includes("$('#merge')"));
});
test('更新頁刻意不列入離線快取，以便跳出舊版程式',async()=>{
  const sw=await readFile(new URL('../offline.js',import.meta.url),'utf8');
  assert.ok(sw.includes('ACTIVATE_UPDATE'));assert.ok(!sw.includes("'./update.html'"));
  assert.ok(sw.includes("'./updates.js'"));
  assert.ok(!sw.includes('caches.match('),'不得從另一版／舊程式的快取誤取首頁');
  assert.ok(sw.includes('caches.open(CACHE).then(cache=>cache.match(cacheKey))'));
});
