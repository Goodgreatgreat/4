// Optional TW cash-stock planning. Never creates orders or ledger entries.
export function tickUp(price){
  if(!Number.isFinite(price)||price<=0||price>1e7)throw Error('價格超出可計算範圍');
  const tick=price<10?.01:price<50?.05:price<100?.1:price<500?.5:price<1000?1:5;
  return Math.round(Math.ceil(price/tick-1e-10)*tick*100)/100;
}
export function swingResult(p,price=null){
  for(const k of ['entry','stop','quantity','trigger','buyFee','feeRate','minimumFee','taxRate','sold','high','protectedStop'])if(typeof p[k]!=='number'||!Number.isFinite(p[k])||p[k]<0)throw Error('請完整填寫有效的計畫數字');
  if(p.entry<=p.stop||p.stop<=0||p.entry>1e6||p.trigger<1||p.trigger>10||!Number.isSafeInteger(p.quantity)||p.quantity<1||!Number.isSafeInteger(p.sold)||p.sold>=p.quantity||p.feeRate>.1||p.taxRate>.1||p.minimumFee>1e6||p.buyFee>1e8)throw Error('請核對進場價、停損、股數與費率；首次賣出須保留餘股');
  const distance=p.entry-p.stop,target=tickUp(p.entry+p.trigger*distance),partial=Math.floor(p.quantity/2),remaining=p.quantity-p.sold;
  // Conservative whole-dollar ceiling for each estimated charge, with a safe upper bound.
  const cost=p.entry*remaining+p.buyFee*remaining/p.quantity;
  const net=x=>x*remaining-Math.ceil(Math.max(x*remaining*p.feeRate,p.minimumFee))-Math.ceil(x*remaining*p.taxRate);
  let lo=p.entry,hi=(cost+p.minimumFee+2)/(remaining*(1-p.feeRate-p.taxRate));
  for(let i=0;i<80;i++){const mid=(lo+hi)/2;if(net(mid)>=cost)hi=mid;else lo=mid;}
  let breakeven=tickUp(hi);if(net(breakeven)<cost)breakeven=tickUp(breakeven+.01);
  const stop=p.sold?Math.max(p.stop,breakeven,p.protectedStop,p.high? p.high-2*distance:0):p.stop;
  const protective=tickUp(stop),r=Number.isFinite(price)&&price>0?(price-p.entry)/distance:null;
  return {distance,target,partial,remaining,breakeven,protective,r,notice:r===null?'尚缺有效行情':price<=protective?'已達／低於計畫停損，請核對券商委託與成交':!p.sold&&price>=target?'已達分批目標；尚未確認成交':p.sold?'已記錄分批成交；請核對餘股停損委託':'尚未達分批目標'};
}
export function validateSwing(s){
  if(s===undefined)return;
  if(!s||typeof s.enabled!=='boolean'||!Array.isArray(s.plans))throw Error('波段擴充資料無效');
  const ids=new Set();for(const p of s.plans){
    if(!p||typeof p.id!=='string'||!p.id||ids.has(p.id)||typeof p.account!=='string'||!/^\d{4,6}$/.test(p.symbol)||typeof p.notes!=='string'||p.notes.length>4000||typeof p.closed!=='boolean'||typeof p.entryDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(p.entryDate)||!Number.isFinite(Date.parse(p.entryDate+'T00:00:00Z'))||new Date(p.entryDate+'T00:00:00Z').toISOString().slice(0,10)!==p.entryDate)throw Error('波段計畫格式無效');
    ids.add(p.id);swingResult(p);
  }
}
