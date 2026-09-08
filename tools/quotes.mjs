import {today} from '../book.js';
import {parseTwseDaily} from './twse.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {checkCatalog} from '../network.js';
const root=new URL('../data/taiwan.json',import.meta.url);
const urls={TWSE:'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',TPEx:'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',bonds:'https://info.tpex.org.tw/api/etfFilter?assetType=bond&etfStrategy=passive&rewardType=Vanilla',TWSE_DAILY:'https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?response=json&type=ALLBUT0999&date='+today().replaceAll('-','')};
async function get(url){for(let n=0;n<2;n++){try{const r=await fetch(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('HTTP '+r.status);return await r.json();}catch(e){if(n===1)throw e;}}}
const results=await Promise.allSettled(Object.values(urls).map(get));let old={stocks:[]};try{old=JSON.parse(await readFile(root,'utf8'));}catch{}
const rows=new Map();let succeeded=0;
function roc(value){const s=String(value).replace(/\D/g,'');const year=Number(s.slice(0,-4))+1911;return `${year}-${s.slice(-4,-2)}-${s.slice(-2)}`;}
for(const [i,board]of ['TWSE','TPEx'].entries()){
  if(results[i].status!=='fulfilled'||(!Array.isArray(results[i].value)||results[i].value.length<500)){for(const q of old.stocks.filter(q=>q.board===board))rows.set(q.symbol,q);console.warn(board+' 暫時失敗，沿用原行情日期');continue;}
  succeeded++;
  for(const r of results[i].value){const symbol=String(i?r.SecuritiesCompanyCode:r.Code).trim().toUpperCase(),name=String(i?r.CompanyName:r.Name).trim(),close=Number(String(i?r.Close:r.ClosingPrice).replaceAll(',',''));if(!/^(?:\d{4}[A-Z]?|00[A-Z0-9]{2,6}|9\d{5})$/.test(symbol)||!name||!(close>0))continue;const raw=String(r.Change??'').replaceAll(',','').trim(),delta=raw===''?NaN:Number(raw);rows.set(symbol,{symbol,name,close,date:roc(r.Date),board,type:symbol.startsWith('00')?'etf':'stock',change:Number.isFinite(delta)&&close-delta>0?delta/(close-delta)*100:null,source:i?'櫃買中心日收盤':'證交所日收盤'});}
}
// The exchange's daily report can be newer than its OpenAPI snapshot.
if(results[3].status==='fulfilled'){
  try{
    const fresh=parseTwseDaily(results[3].value,today());
    if(fresh.length<500)throw Error('當日收盤表資料不完整');
    if(results[0].status!=='fulfilled'||(!Array.isArray(results[0].value)||results[0].value.length<500))succeeded++;
    for(const q of fresh)if(!rows.has(q.symbol)||q.date>=rows.get(q.symbol).date)rows.set(q.symbol,q);
    console.log('已比對證交所當日收盤表，採用每檔較新日期。');
  }catch(e){console.warn(e.message+'；保留可用的官方 OpenAPI 日期');}
}
if(!succeeded)throw Error('官方股價均無法下載，未改動行情檔');
if(process.env.REQUIRE_ALL_MARKETS==='1'&&succeeded!==2)throw Error('部分官方市場失敗，停止部署以保留網站目前行情');
const b=results[2].status==='fulfilled'?results[2].value:null;
if(process.env.REQUIRE_ALL_MARKETS==='1'&&!(b?.status==='success'&&Array.isArray(b.data)&&b.data.length))throw Error('無法核對被動債券 ETF 分類，停止部署');
const exempt=b?.status==='success'&&Array.isArray(b.data)&&b.data.length?new Set(b.data.map(r=>r.stockNo)):new Set(old.stocks.filter(r=>r.type==='bond').map(r=>r.symbol));
for(const [s,q]of rows)if(exempt.has(s))q.type='bond';
const data={format:'slow-taiwan-quotes',generatedAt:new Date().toISOString(),sources:urls,stocks:[...rows.values()].sort((a,b)=>a.symbol.localeCompare(b.symbol))};checkCatalog(data);await mkdir(new URL('../data/',import.meta.url),{recursive:true});await writeFile(root,JSON.stringify(data));console.log(`官方行情：${data.stocks.length} 檔，最新日期 ${data.stocks.map(q=>q.date).sort().at(-1)}；含 ETF 與合資格被動債券分類。`);
await import('./fx.mjs');
