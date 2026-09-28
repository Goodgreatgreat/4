import {day,today} from './book.js';

// network.js — related logic kept in a private scope.
export const {checkCatalog,loadCatalog,relayOrigin,tiingoQuote}=(()=>{
function checkCatalog(data){if(!data||data.format!=='slow-taiwan-quotes'||!Array.isArray(data.stocks)||!data.stocks.length)throw Error('官方行情檔尚未準備完成');const out=Object.create(null);for(const q of data.stocks){if(!q||typeof q.symbol!=='string'||!/^\d[A-Z0-9]{3,7}$/.test(q.symbol)||typeof q.name!=='string'||!q.name.trim()||!['TWSE','TPEx'].includes(q.board)||typeof q.source!=='string'||!['stock','etf','bond'].includes(q.type)||!/^\d{4}-\d{2}-\d{2}$/.test(q.date)||!(q.close>0)||!Number.isFinite(q.close)||out[q.symbol])throw Error('官方行情資料有無效或重複項目');day(q.date);if(q.date>today())throw Error('官方行情日期不能在未來');out[q.symbol]=q;}return out;}
async function loadCatalog(){const response=await fetch(`./data/taiwan.json?v=${Date.now()}`,{cache:'no-store',signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('台股官方行情暫時無法讀取，保留上次資料');return checkCatalog(await response.json());}
function relayOrigin(value=''){if(!value.trim())return '';const u=new URL(value.trim());if(u.protocol!=='https:'||!u.hostname.endsWith('.workers.dev')||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('請使用你自行部署的 https://名稱.workers.dev 網址');return u.origin;}
async function tiingoQuote(symbol,connection){if(!connection.token)throw Error('尚未填寫 Tiingo Token');if(!/^[A-Z][A-Z0-9.-]{0,15}$/.test(symbol))throw Error('美股代號無效');const end=new Date(),start=new Date(end);start.setUTCDate(start.getUTCDate()-10);const qs=new URLSearchParams({startDate:start.toISOString().slice(0,10),endDate:end.toISOString().slice(0,10)});let response;try{response=await fetch(`${relayOrigin(connection.relay||'')||'https://api.tiingo.com'}/tiingo/daily/${symbol}/prices?${qs}`,{headers:{Authorization:`Token ${connection.token}`,Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(15000)});}catch{throw Error('Tiingo 連線失敗；GitHub Pages 可能需要自有中繼。');}if(!response.ok)throw Error(`Tiingo 回應 ${response.status}；請檢查權限或額度`);const rows=await response.json();if(!Array.isArray(rows))throw Error('Tiingo 資料格式無效');const valid=rows.filter(r=>Number.isFinite(r.close)&&r.close>0&&Number.isFinite(Date.parse(r.date))).sort((a,b)=>a.date.localeCompare(b.date));const last=valid.at(-1),previous=valid.at(-2);if(!last)throw Error('尚無可用美股收盤價');const factor=last.splitFactor===undefined?1:Number(last.splitFactor);const base=previous&&factor>0?previous.close/factor:null;return {close:last.close,date:last.date.slice(0,10),change:base?(last.close/base-1)*100:null,source:'Tiingo EOD',splits:valid.filter(r=>r.splitFactor>0&&r.splitFactor!==1).map(r=>({date:r.date.slice(0,10),factor:r.splitFactor}))};}

return {checkCatalog,loadCatalog,relayOrigin,tiingoQuote};
})();

// network.js — related logic kept in a private scope.
export const {SINOPAC_PAGE,SINOPAC_URL,checkFx,parseSinopac,loadFx,fxMode,applyFx}=(()=>{
const SINOPAC_PAGE='https://bank.sinopac.com/mma8/bank/html/rate/bank_ExchangeRate.html';
const SINOPAC_URL='https://mma.sinopac.com/ws/share/rate/ws_exchange.ashx?exchangeType=REMIT&Cross=genREMITResult';
function checkFx(q){
  if(!q||q.format!=='slow-sinopac-fx'||q.currency!=='USD'||q.base!=='TWD'||q.source!=='永豐銀行即期牌告'||!Number.isFinite(q.buy)||!Number.isFinite(q.sell)||q.buy<=0||q.sell<q.buy)throw Error('永豐匯率資料格式無效');
  day(q.date);if(q.date>today()||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(q.quotedAt)||q.quotedAt.slice(0,10)!==q.date)throw Error('永豐匯率日期無效');
  return q;
}
function parseSinopac(text){
  // Parse the bank's public JSONP as data. Never evaluate remote JavaScript.
  const match=text.trim().match(/^genREMITResult\(([\s\S]+)\);?$/);
  if(!match)throw Error('永豐牌告介面格式已變更');
  const rows=JSON.parse(match[1]),head=rows?.[0];
  if(head?.Header!=='SUCCESS'||!Array.isArray(head.SubInfo))throw Error('永豐尚未提供有效牌告');
  const usd=head.SubInfo.filter(r=>r.DataValue4==='USD'&&String(r.DataValue1).includes('(USD)'));
  const time=String(head.TitleInfo).match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)?.[0];
  if(usd.length!==1||!time)throw Error('無法確認永豐美元牌告及報價時間');
  return checkFx({format:'slow-sinopac-fx',currency:'USD',base:'TWD',buy:Number(usd[0].DataValue2),sell:Number(usd[0].DataValue3),date:time.slice(0,10),quotedAt:time,source:'永豐銀行即期牌告',sourceUrl:SINOPAC_PAGE});
}
async function loadFx(){const r=await fetch(`./data/fx.json?v=${Date.now()}`,{cache:'no-store',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('永豐匯率檔未取得');return checkFx(await r.json());}
function fxMode(settings){return settings.fxMode||(settings.fx&&!settings.fx.source?'manual':'sinopac');}
function applyFx(settings,q){checkFx(q);if(fxMode(settings)!=='sinopac'||(settings.fx?.date&&settings.fx.date>q.date))return false;settings.fx={rate:q.buy,date:q.date,quotedAt:q.quotedAt,source:q.source};return true;}

return {SINOPAC_PAGE,SINOPAC_URL,checkFx,parseSinopac,loadFx,fxMode,applyFx};
})();

// network.js — related logic kept in a private scope.
export const {quoteStatus,quoteRefreshInterval,shouldRefresh}=(()=>{

// A fetch success is not proof that the exchange has published today's close.
function quoteStatus(catalog,{online=true,error='',checkedAt='',date=today()}={}){
  const rows=Object.values(catalog),markets=['TWSE','TPEx'].map(board=>{
    const dates=rows.filter(q=>q.board===board).map(q=>q.date).sort();
    return {board,name:board==='TWSE'?'上市':'上櫃',date:dates.at(-1)||null};
  });
  const missing=markets.some(m=>!m.date),stale=markets.some(m=>m.date&&day(date)-day(m.date)>4);
  return {markets,missing,stale,warning:!online||!!error||missing||stale,checkedAt,
    message:!online?'離線中，保留已存行情':error?'更新未完成，保留上次價格':missing?'尚缺官方行情檔，請確認 GitHub 上傳完整':stale?'行情超過 4 個日曆日，請確認休市或 GitHub 排程狀態':'自動讀取已發布的日收盤資料',
    detail:markets.map(m=>`${m.name} ${m.date||'未取得'}`).join(' · ')};
}
function quoteRefreshInterval(now=Date.now()){
  const taipei=new Date(now+8*60*60*1000),weekday=taipei.getUTCDay(),minute=taipei.getUTCHours()*60+taipei.getUTCMinutes();
  return weekday>=1&&weekday<=5&&minute>=13*60+35&&minute<14*60+30?300000:3600000;
}
function shouldRefresh({online=true,visible=true,busy=false,editing=false,last=0,now=Date.now(),force=false}={}){
  return online&&visible&&!busy&&!editing&&(force||now-last>=quoteRefreshInterval(now));
}

return {quoteStatus,quoteRefreshInterval,shouldRefresh};
})();

// network.js — related logic kept in a private scope.
export const {validSymbol,resolveStock}=(()=>{
// Exact exchange-code matching; keep leading zeroes and never use fuzzy prices.
const validSymbol=(symbol,market)=>typeof symbol==='string'&&(market==='TW'?/^(?:\d{4}[A-Z]?|00[A-Z0-9]{2,6}|9\d{5})$/:/^[A-Z][A-Z0-9.-]{0,15}$/).test(symbol);
const common={AAPL:'Apple',NVDA:'NVIDIA',MSFT:'Microsoft',TSLA:'Tesla',META:'Meta',GOOG:'Alphabet',GOOGL:'Alphabet',VOO:'Vanguard S&P 500 ETF',VT:'Vanguard Total World Stock ETF',QQQ:'Invesco QQQ ETF',SPY:'SPDR S&P 500 ETF'};
function resolveStock(raw,forced='auto',catalog={},entries=[]){
  const text=String(raw||'').normalize('NFKC').trim(),upper=text.toUpperCase();
  const match=forced==='US'?null:Object.values(catalog).find(q=>q.symbol===upper||q.name===text);
  const saved=entries.find(e=>e.symbol&&(e.symbol===upper||e.name===text)&&(forced==='auto'||e.market===forced));
  const known=Object.entries(common).find(([s,n])=>s===upper||n.toLowerCase()===text.toLowerCase());
  const symbol=match?.symbol||saved?.symbol||known?.[0]||upper;
  const market=forced==='auto'?(match?'TW':saved?.market||(/^\d/.test(symbol)?'TW':'US')):forced;
  const official=market==='TW'?catalog[symbol]:null;
  return {symbol,market,name:official?.name||saved?.name||known?.[1]||symbol,assetType:official?.type||saved?.assetType||((market==='TW'&&symbol.startsWith('00'))||['VOO','VT','QQQ','SPY'].includes(symbol)?'etf':'stock'),valid:validSymbol(symbol,market)};
}

return {validSymbol,resolveStock};
})();
