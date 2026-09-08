import test from 'node:test';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseTwseDaily} from '../tools/twse.mjs';
import {emptyBook,calculate,totalReturn,classifyPurchase,signal,validate} from '../book.js';
import {quoteStatus,shouldRefresh} from '../quote-status.js';
import {parseSinopac,checkFx,applyFx,fxMode,loadFx} from '../fx.js';
import {categoryContent} from '../panels.js';
const entry=(o={})=>({id:'b',account:'main',kind:'buy',market:'TW',symbol:'2330',name:'台積電',date:'2025-01-01',order:1,price:100,quantity:100,fee:0,tax:0,broker:'standard',assetType:'stock',...o});
const fixture=(change={})=>'genREMITResult('+JSON.stringify([{Header:'SUCCESS',TitleInfo:'報價時間：2025-02-01 15:30:00',QueryDate:'2026/09/08',SubInfo:[{DataValue1:'美元(USD)',DataValue2:'31.4',DataValue3:'31.5',DataValue4:'USD'}],...change}])+');';
test('總報酬率含已實現、未實現、股息，沒有費用重扣',()=>{
  const rows=[entry({fee:20}),entry({id:'s',kind:'sell',date:'2025-02-01',quantity:40,price:120,fee:10,tax:14}),entry({id:'d',kind:'cash',date:'2025-03-01',amount:200})];
  const r=totalReturn(rows,'TW',{'TW:2330':{date:'2025-03-01',close:110}},'2025-03-02');
  assert.equal(r.invested,10020);assert.equal(r.profit,1556);assert.equal(r.rate,1556/10020);
});
test('總報酬率清倉不用現價，換匯及其他市場不混入',()=>{
  const rows=[entry(),entry({id:'s',kind:'sell',date:'2025-02-01',price:110}),entry({id:'d',kind:'cash',date:'2025-03-01',amount:200}),entry({id:'u',market:'US',symbol:'AAPL',price:20})];
  assert.equal(totalReturn(rows,'TW',{},'2025-03-02').rate,.12);
  assert.ok(totalReturn(rows,'US',{},'2025-03-02').reason);
  assert.equal(totalReturn([],'TW',{},'2025-03-02').rate,null);
});
test('後續買進分類留白不清掉原分類，分類及資產配置仍可分开',()=>{
  const b=emptyBook();classifyPurchase(b,entry({category:'long'}));b.classes[0].bucket='其他';
  classifyPurchase(b,entry({category:''}));assert.equal(b.classes[0].category,'long');
  classifyPurchase(b,entry({category:'income'}));assert.equal(b.classes[0].category,'income');assert.equal(b.classes[0].bucket,'其他');
  classifyPurchase(b,entry({account:'other',category:'flex'}));assert.equal(b.classes.length,2);
});
test('清倉不出現買賣訊號，有持股時列出自訂觀察動作',()=>{
  const p=calculate([entry()]).positions[0],q={close:120,date:'2025-02-01',change:5};
  assert.deepEqual(signal({...p,quantity:0,cost:0},q,{rise:3},'2025-02-01'),[]);
  assert.deepEqual(signal(p,q,{profit:10,profitAction:'sell'},'2025-02-01'),['獲利達 10% · 賣出觀察']);
  assert.deepEqual(signal(p,{...q,review:true},{profit:10},'2025-02-01'),[]);
  assert.deepEqual(signal(p,{...q,close:80},{loss:10,lossAction:'buy'},'2025-02-01'),['虧損達 10% · 買入觀察']);
});
test('分類提醒动作驗證且舊備份未設動作仍可讀',()=>{
  const b=emptyBook();validate(b);b.settings.categories[0].profitAction='trade-now';assert.throws(()=>validate(b),/提醒動作/);
});
test('自動抓價遵守離線、背景、編輯保護與節流，手動可略過節流',()=>{
  const args={now:5000000,last:4000000};assert.equal(shouldRefresh(args),false);assert.equal(shouldRefresh({...args,force:true}),true);
  for(const blocked of [{online:false},{visible:false},{editing:true},{busy:true}])assert.equal(shouldRefresh({...args,force:true,...blocked}),false);
  assert.equal(shouldRefresh({now:5000000,last:0}),true);
});
test('行情日期不冒充今日，缺市場、離線、過期及失敗都有提示',()=>{
  const catalog={a:{board:'TWSE',date:'2025-02-01'},b:{board:'TPEx',date:'2025-02-01'}};
  assert.equal(quoteStatus(catalog,{date:'2025-02-02'}).warning,false);
  assert.equal(quoteStatus(catalog,{date:'2025-02-06'}).stale,true);
  assert.match(quoteStatus(catalog,{online:false,date:'2025-02-02'}).message,/離線/);
  assert.match(quoteStatus(catalog,{error:'HTTP',date:'2025-02-02'}).message,/未完成/);
  assert.equal(quoteStatus({},{}).missing,true);
  assert.match(quoteStatus(catalog,{date:'2025-02-02'}).detail,/2025-02-01/);
});
test('永豐採即期銀行買入與銀行報價時間，不以查詢時間冒充更新',()=>{
  const q=parseSinopac(fixture());assert.equal(q.buy,31.4);assert.equal(q.sell,31.5);assert.equal(q.date,'2025-02-01');
  assert.throws(()=>parseSinopac(fixture({Header:'FAIL'})));
  assert.throws(()=>parseSinopac(fixture()+'alert(1)'));
  assert.throws(()=>checkFx({...q,buy:100,sell:30}));
});
test('永豐自動估值不覆蓋手動價或歷史換匯，舊手動設定保留',()=>{
  const b=emptyBook(),q=parseSinopac(fixture());b.entries=[{id:'fx',account:'main',kind:'fxbuy',date:'2025-01-01',order:1,usd:100,twd:3000,fee:0}];
  const history=JSON.stringify(b.entries);assert.equal(fxMode(b.settings),'sinopac');assert.equal(applyFx(b.settings,q),true);assert.equal(b.settings.fx.rate,31.4);
  b.settings.fx={rate:29,date:'2025-01-01'};assert.equal(fxMode(b.settings),'manual');assert.equal(applyFx(b.settings,q),false);assert.equal(b.settings.fx.rate,29);
  assert.equal(JSON.stringify(b.entries),history);
});
test('匯率讀取失敗不傳回假價格',async()=>{
  const original=globalThis.fetch;
  try{globalThis.fetch=async()=>({ok:false});await assert.rejects(loadFx(),/未取得/);globalThis.fetch=async()=>({ok:true,json:async()=>({status:'unavailable'})});await assert.rejects(loadFx(),/格式無效/);}
  finally{globalThis.fetch=original;}
});
test('四種門檻各自提供買入／賣出觀察選項',()=>{
  const html=categoryContent({state:emptyBook(),esc:String,problem:'',field:(label,name,type,value,choices)=>`<label>${label}</label><input name="${name}">${JSON.stringify(choices||[])}`},'long');
  for(const name of ['profit','loss','rise','fall']){assert.ok(html.includes(`name="${name}"`));assert.ok(html.includes(`name="${name}Action"`));}
  assert.ok(html.includes('買入觀察'));assert.ok(html.includes('賣出觀察'));
});
test('需求入口與發布必需檔案同步打包：分類第一格、大勾、圓餅圖、月報、行情',async()=>{
  const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
  const main=await read('main.js'),css=await read('ui.css'),build=await read('tools/build.mjs'),worker=await read('offline.js'),workflow=await read('.github/workflows/pages.yml');
  assert.ok(main.indexOf("field('先選分類")<main.indexOf('哪一檔股票？'));
  assert.match(css,/success \.check\{font-size:4\.5rem/);
  assert.ok(main.includes('<details class="panel" open><summary>持股分類圓餅圖'));
  for(const name of ['stock-filter','records-stock','data-month-report','data-quote-status','setInterval'])assert.ok(main.includes(name));
  for(const file of ['quote-status.js','fx.js','data/fx.json']){assert.ok(build.includes(file));assert.ok(worker.includes(file));}
  assert.ok(workflow.includes('17 9,11 * * 1-5'));assert.ok(workflow.includes('REQUIRE_ALL_MARKETS'));
});
test('行情狀態可以更新多個容器，不阻止自動抓價啟動',async()=>{
  const source=await readFile(new URL('../main.js',import.meta.url),'utf8'),items=[{innerHTML:''},{innerHTML:''}];
  const fn=source.split('\n').find(line=>line.startsWith('function updateQuoteStatus()'));
  runInNewContext(fn+';updateQuoteStatus();',{$$:()=>items,$:()=>{throw Error('single element is not iterable');},priceStatus:()=>'<p>日期</p>'});
  assert.ok(items.every(x=>x.innerHTML==='<p>日期</p>'));
});
test('官方收盤表按欄位解析、保留代號前導零與正確跌幅',()=>{
  const fields=['證券代號','證券名稱','收盤價','漲跌(+/-)','漲跌價差'];
  const data={stat:'OK',date:'20250201',tables:[{fields,data:[['0050','元大台灣50','100.00','<p>-</p>','2.00'],['2330','台積電','--','',''],['00400A','主動ETF','15','X','1']]}]};
  const q=parseTwseDaily(data,'2025-02-01');assert.equal(q.length,2);assert.equal(q[0].symbol,'0050');assert.equal(q[0].type,'etf');assert.equal(q[0].change,-2/102*100);assert.equal(q[1].change,null);
  assert.throws(()=>parseTwseDaily(data,'2025-02-02'));assert.throws(()=>parseTwseDaily({...data,tables:[]},'2025-02-01'));
});
