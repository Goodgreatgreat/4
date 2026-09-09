import {ordered,day,today,quoteKey} from './book.js';
import {relayOrigin} from './network.js';
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const amount=v=>new Intl.NumberFormat('zh-TW',{maximumFractionDigits:6}).format(v);
const monthCache=new Map();
const moveDate=(date,n)=>new Date((day(date)+n)*86400000).toISOString().slice(0,10);

// Visual lot matching only: this does not mutate ledger costs or realized returns.
export function fifoPairs(entries,qk){
  const queues=new Map(),closed=[];
  for(const e of ordered(entries.filter(e=>quoteKey(e)===qk))){
    const lots=queues.get(e.account)||[];queues.set(e.account,lots);
    if(e.kind==='buy')lots.push({buy:e,left:e.quantity,factor:1});
    if(e.kind==='split'||e.kind==='stock'){
      const total=lots.reduce((n,l)=>n+l.left,0);
      if(!total&&e.kind==='stock')throw Error('配股缺少對應買入，暫無法建立 FIFO 圖像配對。');
      const factor=e.kind==='split'?e.factor:1+e.quantity/total;
      for(const lot of lots){lot.left*=factor;lot.factor*=factor;}
    }
    if(e.kind==='sell'){
      let remaining=e.quantity;
      while(remaining>0&&lots.length){
        const lot=lots[0],quantity=Math.min(remaining,lot.left);
        closed.push({buy:lot.buy,sell:e,quantity,buyQuantity:quantity/lot.factor,adjusted:lot.factor!==1});
        remaining-=quantity;lot.left-=quantity;
        if(lot.left===0)lots.shift();
        if(remaining<=e.quantity*Number.EPSILON*8)remaining=0;
      }
      if(remaining>0)throw Error('賣出缺少同帳戶的買入紀錄，暫無法建立 FIFO 圖像配對。');
    }
  }
  return [...closed.reverse(),...[...queues.values()].flat().filter(l=>l.left>0).map(l=>({buy:l.buy,sell:null,quantity:l.left,buyQuantity:l.left/l.factor,adjusted:l.factor!==1})).reverse()];
}

export function checkCandles(rows){
  if(!Array.isArray(rows))throw Error('歷史股價格式不正確');
  const unique=new Map();
  for(const r of rows){
    day(r.date);
    if(r.date>today()||['open','high','low','close'].some(k=>!Number.isFinite(r[k])||r[k]<=0)||r.low>Math.min(r.open,r.close)||r.high<Math.max(r.open,r.close)||r.high<r.low)throw Error('歷史股價有無效日期或開高低收數值');
    const old=unique.get(r.date);
    if(old&&['open','high','low','close'].some(k=>old[k]!==r[k]))throw Error('同日歷史股價互相衝突，請核對資料來源');
    unique.set(r.date,{date:r.date,open:r.open,high:r.high,low:r.low,close:r.close});
  }
  return [...unique.values()].sort((a,b)=>a.date.localeCompare(b.date));
}

export function parseTaiwanHistory(data,symbol,board){
  if(!/^\d[A-Z0-9]{3,7}$/.test(symbol))throw Error('股票代號不正確');
  const table=board==='TPEx'?data?.tables?.[0]:data;
  const title=String(board==='TPEx'?table?.subtitle:table?.title);
  if(board==='TPEx'?String(data?.code)!==symbol:!title.split(/\s+/).includes(symbol))throw Error('歷史資料的股票代號不相符');
  if(!Array.isArray(table?.data)||!Array.isArray(table.fields))throw Error('官方歷史行情尚未提供或欄位已變更');
  const fields=table.fields.map(f=>f.replace(/\s/g,'').replace(/價$/,''));
  const names=['日期','開盤','最高','最低','收盤'],indices=names.map(n=>fields.indexOf(n));
  if(indices.some(i=>i<0))throw Error('官方歷史行情欄位已變更');
  const rows=table.data.flatMap(row=>{
    const raw=indices.slice(1).map(i=>String(row[i]).replaceAll(',','').trim());
    if(raw.every(v=>/^(--+|---|N\/A)?$/.test(v)))return [];
    const parts=String(row[indices[0]]).split('/');
    if(parts.length!==3)throw Error('官方歷史行情日期格式已變更');
    const year=Number(parts[0])+(parts[0].length<=3?1911:0),date=`${year}-${parts[1].padStart(2,'0')}-${parts[2].padStart(2,'0')}`;
    return [{date,open:Number(raw[0]),high:Number(raw[1]),low:Number(raw[2]),close:Number(raw[3])}];
  });
  return checkCandles(rows);
}

export function historyMonths(start,end){
  day(start);day(end);if(start>end)throw Error('歷史區間起訖顛倒');
  const months=[];let date=start.slice(0,7)+'-01';
  while(date.slice(0,7)<=end.slice(0,7)){
    if(months.length>=240)throw Error('一次最多查詢 20 年歷史行情');
    months.push(date);const d=new Date(date+'T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+1);date=d.toISOString().slice(0,10);
  }
  return months;
}
export function historyUrl(symbol,board,month){
  const query=new URLSearchParams(board==='TPEx'?{code:symbol,date:month.replaceAll('-','/'),response:'json'}:{stockNo:symbol,date:month.replaceAll('-',''),response:'json'});
  return (board==='TPEx'?'https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?':'https://www.twse.com.tw/exchangeReport/STOCK_DAY?')+query;
}
export function requestRange(pair){
  const last=pair.sell?.date||today();
  return {start:moveDate(pair.buy.date,-31),end:moveDate(last,31)>today()?today():moveDate(last,31)};
}
async function json(url,headers,signal){
  const timeout=new AbortController(),abort=()=>timeout.abort();
  if(signal?.aborted)abort();signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,15000);
  try{const r=await fetch(url,{headers,signal:timeout.signal,cache:'no-store',credentials:'omit'});if(!r.ok)throw Error(`行情來源回應 ${r.status}`);return await r.json();}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
export async function loadHistory(pair,board,connection={},signal,onProgress=()=>{}){
  const {start,end}=requestRange(pair),symbol=pair.buy.symbol;
  if(pair.buy.market==='US'){
    if(!connection.enabled||!connection.token)throw Error('美股日 K 線需先在設定啟用 Tiingo 並填入 Token。');
    if(!/^[A-Z][A-Z0-9.-]{0,15}$/.test(symbol))throw Error('美股代號不正確');
    const qs=new URLSearchParams({startDate:start,endDate:end});
    const rows=await json(`${relayOrigin(connection.relay||'')||'https://api.tiingo.com'}/tiingo/daily/${symbol.replaceAll('.','-')}/prices?${qs}`,{Authorization:`Token ${connection.token}`,Accept:'application/json'},signal);
    if(!Array.isArray(rows))throw Error('Tiingo 歷史資料格式不正確');
    return {rows:checkCandles(rows.map(r=>({date:r.date?.slice(0,10),open:r.open,high:r.high,low:r.low,close:r.close}))),source:'Tiingo · 未還原日 K 線'};
  }
  if(!['TWSE','TPEx'].includes(board))throw Error('請先更新台股行情目錄，以確認這檔股票的上市／上櫃市場。');
  // TPEx currently omits CORS permission. Do not bypass it through an unknown proxy.
  if(board==='TPEx')throw Error('櫃買歷史行情目前不允許網站直接跨站讀取。請展開下方「匯入官方歷史資料」下載並匯入所需月份。');
  const months=historyMonths(start,end),all=[];
  for(const [i,month] of months.entries()){
    if(signal?.aborted)throw Error('已停止讀取');
    onProgress(`讀取 ${month.slice(0,7)}（${i+1}/${months.length}）…`);
    const cacheKey=`${board}:${symbol}:${month}`,cached=monthCache.get(cacheKey);
    let rows;
    if(cached&&Date.now()-cached.at<(month.slice(0,7)===today().slice(0,7)?300000:86400000))rows=cached.rows;
    else{
      rows=parseTaiwanHistory(await json(historyUrl(symbol,board,month),{Accept:'application/json'},signal),symbol,board);
      if(signal?.aborted)throw Error('已停止讀取');
      monthCache.set(cacheKey,{rows,at:Date.now()});
      if(monthCache.size>300)monthCache.delete(monthCache.keys().next().value);
    }
    all.push(...rows);
  }
  return {rows:checkCandles(all),source:'證交所 · 未還原日 K 線'};
}

export function holdingWindow(rows,pair){
  const valid=checkCandles(rows),buy=valid.findIndex(r=>r.date===pair.buy.date);
  const sell=pair.sell?valid.findIndex(r=>r.date===pair.sell.date):valid.length-1;
  if(buy<0||sell<buy)throw Error('缺少買入日或賣出日的日 K 線；請核對交易日期並補齊歷史資料。');
  const selected=valid.slice(Math.max(0,buy-3),Math.min(valid.length,sell+4));
  const warnings=[];
  if(buy<3)warnings.push(`買入前僅有 ${buy} 個交易日資料`);
  if(pair.sell&&valid.length-sell-1<3)warnings.push(`賣出後僅有 ${valid.length-sell-1} 個交易日資料；不補畫尚未發生的行情`);
  const months=historyMonths(pair.buy.date,pair.sell?.date||valid[sell].date);
  if(months.some(m=>!valid.some(r=>r.date.startsWith(m.slice(0,7)))))warnings.push('持有區間有整月無行情，可能為停牌或資料缺漏，請核對');
  return {rows:selected,warnings};
}

export function tradeChartSvg(rows,pair,width=560){
  const data=holdingWindow(rows,pair).rows,w=Math.max(240,Math.round(width)),h=290,left=48,right=w-14,top=48,bottom=240;
  const prices=data.flatMap(r=>[r.high,r.low]).concat(pair.buy.price,pair.sell?.price||pair.buy.price);
  const min=Math.min(...prices),max=Math.max(...prices),pad=(max-min)*.06||max*.02||1,lo=min-pad,hi=max+pad;
  const slot=(right-left)/data.length,x=i=>left+(i+.5)*slot,y=v=>top+(hi-v)/(hi-lo)*(bottom-top),bw=Math.max(.3,Math.min(10,slot*.7));
  const grid=[lo,(lo+hi)/2,hi].map(v=>`<line x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}" stroke="#e7dacc"/><text x="${left-5}" y="${y(v)+4}" text-anchor="end" font-size="12" fill="#79695d">${new Intl.NumberFormat('zh-TW',{notation:'compact',maximumFractionDigits:2}).format(v)}</text>`).join('');
  const candles=data.map((r,i)=>{const color=r.close>=r.open?'#b72e35':'#28734b';return `<g opacity="0.38"><title>${r.date} 開 ${r.open} 高 ${r.high} 低 ${r.low} 收 ${r.close}</title><line x1="${x(i)}" x2="${x(i)}" y1="${y(r.high)}" y2="${y(r.low)}" stroke="${color}" stroke-width="${Math.min(1,slot*.7)}"/><rect x="${x(i)-bw/2}" y="${Math.min(y(r.open),y(r.close))}" width="${bw}" height="${Math.max(.7,Math.abs(y(r.open)-y(r.close)))}" fill="${color}"/></g>`;}).join('');
  const markers=[['買入',pair.buy,'#385e7e',18],...(pair.sell?[['賣出',pair.sell,'#865719',36]]:[])].map(([label,e,color,ty])=>{const px=x(data.findIndex(r=>r.date===e.date));return `<line x1="${px}" x2="${px}" y1="42" y2="${bottom+4}" stroke="${color}" stroke-width="1.8" stroke-dasharray="5 3"/><circle cx="${px}" cy="${y(e.price)}" r="4" fill="${color}"/><text x="${label==='買入'?left:right}" y="${ty}" text-anchor="${label==='買入'?'start':'end'}" font-size="13" fill="${color}">${label} ${e.date} · ${amount(e.price)}</text>`;}).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="FIFO 買賣日與整段持有期間日 K 線" font-family="Microsoft JhengHei, sans-serif"><title>${escape(pair.buy.symbol)} · ${escape(pair.buy.account)} · FIFO 配對 ${amount(pair.quantity)} 股；未還原日 K 線，非含費稅報酬</title><rect width="${w}" height="${h}" fill="#fffdf9"/>${grid}${candles}${markers}<text x="${left}" y="266" font-size="12" fill="#79695d">${data[0].date}</text><text x="${right}" y="266" text-anchor="end" font-size="12" fill="#79695d">${data.at(-1).date}</text></svg>`;
}

async function saveImage(svg,pair){
  const img=new Image();img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
  await img.decode();const canvas=document.createElement('canvas');canvas.width=1680;canvas.height=Math.round(1680*290/560);
  canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw Error('目前無法儲存圖檔');
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${pair.buy.symbol}-FIFO-${pair.buy.date}-${pair.sell?.date||today()}.png`;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}

export function mountTradeChart(container,{entries,qk,board,connection,accountName}){
  let pairs;try{pairs=fifoPairs(entries,qk);}catch(e){container.innerHTML=`<p class="warning">${escape(e.message)}</p>`;return ()=>{};}
  if(!pairs.length){container.innerHTML='<p class="empty">尚無買入紀錄可繪圖。</p>';return ()=>{};}
  container.innerHTML=`<div class="field"><label for="fifo-pair">先進先出配對</label><select id="fifo-pair">${pairs.map((p,i)=>`<option value="${i}">${escape(p.buy.date)} → ${escape(p.sell?.date||'持有中')} · ${amount(p.quantity)} 股 · ${escape(accountName(p.buy.account))}</option>`).join('')}</select></div><p class="meta">整段持有期間，前後各保留最多 3 個交易日。FIFO 只用於此圖配對；帳務成本仍為加權平均。</p><div class="actions"><button type="button" class="secondary" data-history-load>重新讀取日 K 線</button><button type="button" class="secondary" data-chart-save disabled>儲存圖片</button></div><p class="meta" data-chart-status role="status"></p><div class="trade-plot"></div><p class="meta" data-chart-note></p>${qk.startsWith('TW:')?'<details class="more"><summary>匯入官方歷史資料（連線受限時）</summary><p class="meta">開啟所需月份，儲存官方 JSON 後選取檔案，可一次選多份。不匯入帳本，只暫存於這個視窗。</p><div class="history-links"></div><label class="field">選取官方 JSON<input type="file" accept=".json,application/json" multiple data-history-files></label></details>':''}`;
  const $=s=>container.querySelector(s),select=$('#fifo-pair'),plot=$('.trade-plot'),status=$('[data-chart-status]'),save=$('[data-chart-save]');
  let controller=null,seq=0,current=null,imported=[],disposed=false;
  const pair=()=>pairs[Number(select.value)];
  function paint(){if(!current||disposed)return;const p=pair(),window=holdingWindow(current.rows,p);plot.innerHTML=tradeChartSvg(current.rows,p,plot.getBoundingClientRect().width||560);save.disabled=false;status.textContent=current.source+' · '+window.rows[0].date+' ～ '+window.rows.at(-1).date;status.className='meta';$('[data-chart-note]').textContent=[`${amount(p.quantity)} 股${p.adjusted?'（賣出時股數）；包含配股／分割，原始買入對應 '+amount(p.buyQuantity)+' 股':''}。半透明紅／綠 K 線＝收盤較開盤漲／跌；實際成交價為圓點。未還原價格可能因除權息／分割出現跳空，不代表投資報酬。`,...window.warnings].join(' ');}
  function links(){if(!$('[data-history-files]'))return;const range=requestRange(pair());$('.history-links').innerHTML=historyMonths(range.start,range.end).map(m=>`<a target="_blank" rel="noopener noreferrer" href="${escape(historyUrl(pair().buy.symbol,board,m))}">${m.slice(0,7)} ↗</a>`).join('');}
  async function load(){
    const id=++seq;controller?.abort();controller=new AbortController();current=null;plot.innerHTML='';save.disabled=true;$('[data-chart-note]').textContent='';status.className='meta';status.textContent='正在讀取歷史日 K 線…';
    try{links();const data=await loadHistory(pair(),board,connection,controller.signal,text=>{if(id===seq&&!disposed)status.textContent=text;});if(id!==seq||disposed)return;current=data;paint();}
    catch(e){if(id!==seq||disposed)return;current=null;status.className='warning';status.textContent=e.name==='TypeError'?'歷史行情連線失敗，可能為離線或來源限制；不會用今天價格補畫過去。':e.message;}
  }
  select.onchange=()=>{imported=[];void load();};$('[data-history-load]').onclick=()=>void load();
  save.onclick=async()=>{save.disabled=true;try{await saveImage(tradeChartSvg(current.rows,pair(),560),pair());}catch(e){status.textContent=e.message;}finally{if(!disposed)save.disabled=!current;}};
  if($('[data-history-files]'))$('[data-history-files]').onchange=async event=>{
    const files=[...event.target.files],id=++seq;controller?.abort();
    try{
      if(files.length>240||files.reduce((n,f)=>n+f.size,0)>10000000)throw Error('歷史檔案過大，請分批選取');
      const rows=[];for(const f of files)rows.push(...parseTaiwanHistory(JSON.parse(await f.text()),pair().buy.symbol,board));
      if(id!==seq||disposed)return;imported=checkCandles([...imported,...rows]);current={rows:imported,source:'手動匯入官方格式 · 請自行核對檔案來源'};paint();
    }catch(e){if(id===seq&&!disposed){current=null;save.disabled=true;plot.innerHTML='';status.className='warning';status.textContent=e.message;}}
  };
  const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(()=>{if(current)paint();}):null;observer?.observe(plot);
  void load();
  return ()=>{disposed=true;seq++;controller?.abort();observer?.disconnect();};
}
