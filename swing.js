import {validateJournals} from './swing-journal.js';
import {roundTwd} from './tw-fees.js';
// Optional TW cash-stock planning. Never creates orders or ledger entries.
export function tickUp(price){
  if(!Number.isFinite(price)||price<=0||price>1e7)throw Error('價格超出可計算範圍');
  const tick=price<10?.01:price<50?.05:price<100?.1:price<500?.5:price<1000?1:5;
  return Math.round(Math.ceil(price/tick-1e-10)*tick*100)/100;
}
export function swingResult(p,price=null){
  for(const k of ['entry','stop','quantity','trigger','buyFee','feeRate','minimumFee','taxRate','sold','high','protectedStop'])if(typeof p[k]!=='number'||!Number.isFinite(p[k])||p[k]<0)throw Error('請完整填寫有效的計畫數字');
  if(p.entry<=p.stop||p.stop<=0||p.entry>1e6||p.trigger<1||p.trigger>10||!Number.isSafeInteger(p.quantity)||p.quantity<1||!Number.isSafeInteger(p.sold)||p.sold>=p.quantity||p.feeRate>.1||p.taxRate>.1||p.minimumFee>1e6||p.buyFee>1e8)throw Error('請核對進場價、停損、股數與費率；首次賣出須保留餘股');
  const distance=p.entry-p.stop,target=tickUp(p.entry+p.trigger*distance),partial=Math.floor(p.quantity*(p.sellPercent??50)/100),remaining=p.quantity-p.sold;
  const cost=p.entry*remaining+p.buyFee*remaining/p.quantity;
  const net=x=>x*remaining-roundTwd(Math.max(x*remaining*p.feeRate,p.minimumFee),p.feeRounding||'ceil')-roundTwd(x*remaining*p.taxRate,p.taxRounding||'ceil');
  let breakeven=tickUp(cost/remaining),steps=0;
  while(net(breakeven)<cost-1e-8){if(++steps>200000)throw Error('費用過高，請核對股數');breakeven=tickUp(breakeven+.001);}
  const stop=(p.sold||p.activated)?Math.max(p.stop,breakeven,p.protectedStop,p.high? p.high-2*distance:0):p.stop;
  const protective=tickUp(stop),r=Number.isFinite(price)&&price>0?(price-p.entry)/distance:null;
  return {distance,target,partial,remaining,breakeven,protective,r,notice:r===null?'尚缺有效行情':price<=protective?'已達／低於計畫停損，請核對券商委託與成交':!p.sold&&!p.activated&&price>=target?(partial?'已達分批目標；尚未確認成交':'已達保本門檻；請確認保本委託'):(p.sold||p.activated)?'已啟動保本；請核對餘股停損委託':'尚未達分批目標'};
}
export function validateStrategy(d){
  const mode=d.stopMode??'percent';
  if(!['percent','price'].includes(mode)||![d.trigger,d.quantity,d.sellPercent].every(Number.isFinite)||d.trigger<1||d.trigger>10||!Number.isSafeInteger(d.quantity)||d.quantity<1||d.quantity>1e8||d.sellPercent<0||d.sellPercent>=100)throw Error('請核對策略模式、R、股數與分批比例');
  if(mode==='percent'&&(!Number.isFinite(d.riskPercent)||d.riskPercent<=0||d.riskPercent>=100))throw Error('停損幅度須大於 0% 且小於 100%');
}
export function validateSwing(s){
  if(s===undefined)return;
  if(!s||typeof s.enabled!=='boolean'||!Array.isArray(s.plans))throw Error('波段擴充資料無效');
  validateJournals(s.journals);
  if(s.defaults)validateStrategy(s.defaults);
  const ids=new Set();for(const p of s.plans){
    if(!p||typeof p.id!=='string'||!p.id||ids.has(p.id)||typeof p.account!=='string'||!/^\d{4,6}$/.test(p.symbol)||typeof p.notes!=='string'||p.notes.length>4000||typeof p.closed!=='boolean'||typeof p.entryDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(p.entryDate)||!Number.isFinite(Date.parse(p.entryDate+'T00:00:00Z'))||new Date(p.entryDate+'T00:00:00Z').toISOString().slice(0,10)!==p.entryDate)throw Error('波段計畫格式無效');
    if(p.label!==undefined&&(typeof p.label!=='string'||p.label.length>120))throw Error('波段名稱過長');
    if(p.sellPercent!==undefined&&(!Number.isFinite(p.sellPercent)||p.sellPercent<0||p.sellPercent>=100))throw Error('分批比例無效');
    for(const k of ['feeRounding','taxRounding'])if(p[k]!==undefined&&!['round','floor','ceil'].includes(p[k]))throw Error('波段費稅取整無效');
    ids.add(p.id);swingResult(p);
  }
}
