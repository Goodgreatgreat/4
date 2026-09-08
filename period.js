import {calculate,day,today,quoteKey,xirr} from './book.js';
export const priorDate=date=>new Date((day(date)-1)*86400000).toISOString().slice(0,10);
export function reportRange(mode,period,start,end,entries=[],asOf=today()){
  if(mode==='all'){start=entries.map(e=>e.date).sort()[0]||asOf;end=asOf;}
  else if(mode==='month'){
    if(!/^\d{4}-\d{2}$/.test(period))throw Error('請選擇正確月份');
    start=period+'-01';day(start);const d=new Date(start+'T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+1);d.setUTCDate(0);end=d.toISOString().slice(0,10);
  }else if(mode==='year'){
    if(!/^\d{4}$/.test(period))throw Error('請填四位數年份');
    start=period+'-01-01';end=period+'-12-31';
  }else if(mode!=='range')throw Error('期間選項無效');
  day(start);day(end);if(mode!=='range'&&end>asOf)end=asOf;
  if(start>end)throw Error('開始日期不能晚於結束日期');
  if(end>asOf)throw Error('請選擇已發生的日期');
  return {start,end};
}
export function realizedReport(entries,stock,start,end){
  day(start);day(end);if(start>end)throw Error('日期範圍無效');
  const b=calculate(entries.filter(e=>!e.kind.startsWith('fx')&&(!stock||quoteKey(e)===stock)&&e.date<=end));
  const rows=b.results.filter(e=>e.date>=start);
  return {book:b,rows,realized:rows.reduce((s,e)=>s+e.pnl,0),dividend:rows.reduce((s,e)=>s+e.dividend,0),cost:rows.reduce((s,e)=>s+e.allocated,0)};
}
// Start = the beginning of the selected day, end = the end of the selected day.
// Costs always use full history; start/end prices value shares at the boundaries.
export function periodPerformance(entries,stock,start,end,valuations={}){
  day(start);day(end);if(start>end||end>today())throw Error('日期範圍無效');
  const selected=entries.filter(e=>quoteKey(e)===stock&&!e.kind.startsWith('fx'));
  const opening=calculate(selected.filter(e=>e.date<start)).positions.reduce((s,p)=>s+p.quantity,0);
  const report=realizedReport(selected,stock,start,end);
  const closing=report.book.positions.reduce((s,p)=>s+p.quantity,0),openingDate=priorDate(start),missing=[];
  function value(quantity,q,boundary,label){
    if(!quantity)return 0;
    let valid=!!q&&Number.isFinite(q.close)&&q.close>0&&!q.review;
    try{day(q?.date);valid&&=q.date<=boundary;}catch{valid=false;}
    if(!valid){missing.push(label);return null;}
    return quantity*q.close;
  }
  const openingValue=value(opening,valuations.opening,openingDate,'期初股價'),endingValue=value(closing,valuations.ending,end,'期末股價');
  const base={...report,opening,closing,openingDate,openingValue,endingValue,missing};
  if(missing.length)return {...base,reason:'請補齊'+missing.join('、')};
  const flows=[];if(openingValue)flows.push({date:openingDate,amount:-openingValue});
  flows.push(...report.rows.filter(r=>r.cash!==0).map(r=>({date:r.date,amount:r.cash})));
  if(closing)flows.push({date:end,amount:endingValue});
  const profit=endingValue-openingValue+report.rows.reduce((s,r)=>s+r.cash,0);
  const result=xirr(flows);
  return {...base,...result,profit,flowStart:flows[0]?.date,flowEnd:flows.at(-1)?.date};
}
