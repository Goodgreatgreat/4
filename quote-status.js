import {day,today} from './book.js';

// A fetch success is not proof that the exchange has published today's close.
export function quoteStatus(catalog,{online=true,error='',checkedAt='',date=today()}={}){
  const rows=Object.values(catalog),markets=['TWSE','TPEx'].map(board=>{
    const dates=rows.filter(q=>q.board===board).map(q=>q.date).sort();
    return {board,name:board==='TWSE'?'上市':'上櫃',date:dates.at(-1)||null};
  });
  const missing=markets.some(m=>!m.date),stale=markets.some(m=>m.date&&day(date)-day(m.date)>4);
  return {markets,missing,stale,warning:!online||!!error||missing||stale,checkedAt,
    message:!online?'離線中，保留已存行情':error?'更新未完成，保留上次價格':missing?'尚缺官方行情檔，請確認 GitHub 上傳完整':stale?'行情超過 4 個日曆日，請確認休市或 GitHub 排程狀態':'自動讀取已發布的日收盤資料',
    detail:markets.map(m=>`${m.name} ${m.date||'未取得'}`).join(' · ')};
}
export function quoteRefreshInterval(now=Date.now()){
  const taipei=new Date(now+8*60*60*1000),weekday=taipei.getUTCDay(),minute=taipei.getUTCHours()*60+taipei.getUTCMinutes();
  return weekday>=1&&weekday<=5&&minute>=13*60+45&&minute<14*60+30?300000:3600000;
}
export function shouldRefresh({online=true,visible=true,busy=false,editing=false,last=0,now=Date.now(),force=false}={}){
  return online&&visible&&!busy&&!editing&&(force||now-last>=quoteRefreshInterval(now));
}
