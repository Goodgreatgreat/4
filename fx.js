import {day,today} from './book.js';
export const SINOPAC_PAGE='https://bank.sinopac.com/mma8/bank/html/rate/bank_ExchangeRate.html';
export const SINOPAC_URL='https://mma.sinopac.com/ws/share/rate/ws_exchange.ashx?exchangeType=REMIT&Cross=genREMITResult';
export function checkFx(q){
  if(!q||q.format!=='slow-sinopac-fx'||q.currency!=='USD'||q.base!=='TWD'||q.source!=='永豐銀行即期牌告'||!Number.isFinite(q.buy)||!Number.isFinite(q.sell)||q.buy<=0||q.sell<q.buy)throw Error('永豐匯率資料格式無效');
  day(q.date);if(q.date>today()||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(q.quotedAt)||q.quotedAt.slice(0,10)!==q.date)throw Error('永豐匯率日期無效');
  return q;
}
export function parseSinopac(text){
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
export async function loadFx(){const r=await fetch(`./data/fx.json?v=${Date.now()}`,{cache:'no-store',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('永豐匯率檔未取得');return checkFx(await r.json());}
export function fxMode(settings){return settings.fxMode||(settings.fx&&!settings.fx.source?'manual':'sinopac');}
export function applyFx(settings,q){checkFx(q);if(fxMode(settings)!=='sinopac'||(settings.fx?.date&&settings.fx.date>q.date))return false;settings.fx={rate:q.buy,date:q.date,quotedAt:q.quotedAt,source:q.source};return true;}
