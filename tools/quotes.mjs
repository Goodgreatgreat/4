import {today} from '../book.js';
import {parseTwseDaily} from './twse.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {checkCatalog} from '../network.js';
import {checkFx} from '../fx.js';
import {parseMarket,mergeQuotes} from './quote-merge.mjs';
const root=new URL('../data/taiwan.json',import.meta.url);
const urls={TWSE:'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',TPEx:'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',bonds:'https://info.tpex.org.tw/api/etfFilter?assetType=bond&etfStrategy=passive&rewardType=Vanilla',TWSE_DAILY:'https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?response=json&type=ALLBUT0999&date='+today().replaceAll('-','')};
const published='https://goodgreatgreat.github.io/4/data/';
async function get(url){for(let n=0;n<3;n++){try{const r=await fetch(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(20000),redirect:'error'});if(!r.ok)throw Error('HTTP '+r.status);return await r.json();}catch(e){if(n===2)throw e;await new Promise(resolve=>setTimeout(resolve,1000*(n+1)));}}}
const results=await Promise.allSettled([...Object.values(urls),published+'taiwan.json?v='+Date.now(),published+'fx.json?v='+Date.now()].map(get));
let previous=[],publishedReady=false;
try{previous=Object.values(checkCatalog(JSON.parse(await readFile(root,'utf8'))));}catch(e){console.warn('儲存庫舊行情不可用：'+e.message);}
try{if(results[4].status==='rejected')throw results[4].reason;const q=Object.values(checkCatalog(results[4].value));if(['TWSE','TPEx'].some(board=>q.filter(r=>r.board===board).length<500))throw Error('線上備援市場資料不完整');previous=mergeQuotes(previous,q,new Set(q.filter(x=>x.type==='bond').map(x=>x.symbol)));publishedReady=true;console.log('已核對目前發布行情，逐檔防止日期倒退。');}catch(e){console.warn('無法確認線上最後行情：'+e.message);}
const fresh=[],success=new Set();
for(const [i,board]of ['TWSE','TPEx'].entries())try{if(results[i].status==='rejected')throw results[i].reason;fresh.push(...parseMarket(results[i].value,board));success.add(board);}catch(e){console.warn(board+' 抓價失敗：'+e.message+'；保留已驗證舊行情日期。');}
try{if(results[3].status==='rejected')throw results[3].reason;const q=parseTwseDaily(results[3].value,today());if(q.length<500)throw Error('當日收盤表尚未完整');checkCatalog({format:'slow-taiwan-quotes',stocks:q});fresh.push(...q);success.add('TWSE');}catch(e){console.warn('證交所當日表：'+e.message+'；不冒用今日日期。');}
let bonds=null;const b=results[2].status==='fulfilled'?results[2].value:null;
if(b?.status==='success'&&Array.isArray(b.data)&&b.data.length&&b.data.every(r=>typeof r.stockNo==='string'))bonds=new Set(b.data.map(r=>r.stockNo));
else console.warn('債券 ETF 分類不可用：沿用確認分類，暫不加入未知新 ETF。');
if((success.size<2||bonds===null)&&!publishedReady)throw Error('行情或分類不完整，且無法確認線上最後資料；停止發布避免倒退。');
const stocks=mergeQuotes(previous,fresh,bonds);
// REQUIRE_ALL_MARKETS requires usable coverage, rather than every endpoint succeeding.
if(process.env.REQUIRE_ALL_MARKETS==='1')for(const board of ['TWSE','TPEx'])if(stocks.filter(q=>q.board===board).length<500)throw Error(board+' 沒有足夠可用的新行情或已驗證備援');
const data={format:'slow-taiwan-quotes',generatedAt:new Date().toISOString(),sources:urls,stocks};checkCatalog(data);
await mkdir(new URL('../data/',import.meta.url),{recursive:true});await writeFile(root,JSON.stringify(data));
console.log('可發布 '+stocks.length+' 檔；'+(success.size<2?'部分來源失敗，保留原日期，不阻擋程式更新。':'來源通過檢查。'));
try{if(results[5].status==='fulfilled'){const q=checkFx(results[5].value),file=new URL('../data/fx.json',import.meta.url);let old;try{old=checkFx(JSON.parse(await readFile(file,'utf8')));}catch{}if(!old||q.quotedAt>old.quotedAt)await writeFile(file,JSON.stringify(q));}}catch(e){console.warn('線上匯率備援未採用：'+e.message);}
await import('./fx.mjs');
