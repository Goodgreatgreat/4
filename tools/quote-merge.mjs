import {checkCatalog} from '../network.js';
import {day,today} from '../book.js';
export function quoteDate(value){const s=String(value).replace(/\D/g,'');const date=s.length===8?`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6)}`:s.length===7?`${Number(s.slice(0,3))+1911}-${s.slice(3,5)}-${s.slice(5)}`:'';day(date);if(date>today())throw Error('行情日期在未來');return date;}
export function parseMarket(data,board){
 if(!Array.isArray(data))throw Error('回應不是行情陣列');const out=[];
 for(const r of data){const tw=board==='TWSE',symbol=String(tw?r.Code:r.SecuritiesCompanyCode).trim().toUpperCase(),name=String((tw?r.Name:r.CompanyName)||'').trim(),close=Number(String(tw?r.ClosingPrice:r.Close).replaceAll(',',''));
 if(!/^(?:\d{4}[A-Z]?|00[A-Z0-9]{2,6}|9\d{5})$/.test(symbol)||!name||!Number.isFinite(close)||close<=0)continue;
 const change=String(r.Change??'').replaceAll(',','').trim(),delta=change===''?NaN:Number(change);
 out.push({symbol,name,close,date:quoteDate(r.Date),board,type:symbol.startsWith('00')?'etf':'stock',change:Number.isFinite(delta)&&close-delta>0?delta/(close-delta)*100:null,source:tw?'證交所日收盤':'櫃買中心日收盤'});}
 if(out.length<500)throw Error(`有效行情只有 ${out.length} 筆（原回應 ${data.length} 筆）`);checkCatalog({format:'slow-taiwan-quotes',stocks:out});return out;
}
export function mergeQuotes(previous,fresh,bonds=null){
 const rows=new Map(previous.map(q=>[q.symbol,{...q}]));
 for(const q of fresh){const old=rows.get(q.symbol);if(old&&old.date>q.date)continue;
 if(bonds===null&&!old&&q.type!=='stock')continue;
 rows.set(q.symbol,{...q,type:bonds===null?(old?.type||q.type):bonds.has(q.symbol)?'bond':q.type});}
 return [...rows.values()].sort((a,b)=>a.symbol.localeCompare(b.symbol));
}
