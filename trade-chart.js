import {ordered,day,today,quoteKey} from './book.js';
import {relayOrigin} from './network.js';
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const amount=v=>new Intl.NumberFormat('zh-TW',{maximumFractionDigits:6}).format(v);
const monthCache=new Map();
const stores=new Map(),work=new Map(),listeners=new Set(),failures=new Map();
let workQueue=Promise.resolve();
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
        if(lot.left<=Math.max(lot.buy.quantity*lot.factor,quantity)*Number.EPSILON*8)lots.shift();
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

// A separate scope-specific database holds only public OHLC data, never the ledger or Token.
export function createReviewCache(scope,idb=globalThis.indexedDB){
  const memory=new Map();let opened;
  const open=()=>opened??=(new Promise(resolve=>{
    if(!idb){resolve(null);return;}
    let request;try{request=idb.open('slow-review-prices:1:'+scope,1);}catch{resolve(null);return;}
    let finished=false;const finish=db=>{if(finished){db?.close();return;}finished=true;clearTimeout(timer);if(db)db.onversionchange=()=>db.close();resolve(db);};
    const timer=setTimeout(()=>finish(null),2500);
    request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('prices'))request.result.createObjectStore('prices');};
    request.onsuccess=()=>finish(request.result);request.onerror=request.onblocked=()=>finish(null);
  }));
  return {
    async get(key){
      if(memory.has(key))return memory.get(key);
      const db=await open();if(!db)return null;
      const value=await new Promise(resolve=>{try{const tx=db.transaction('prices','readonly'),r=tx.objectStore('prices').get(key);r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>resolve(null);tx.onabort=()=>resolve(null);}catch{resolve(null);}});
      try{if(value?.format!=='slow-review-prices-1')return null;const clean={...value,rows:checkCandles(value.rows),durable:true};memory.set(key,clean);return clean;}catch{return null;}
    },
    async put(key,value){
      const prior=await this.get(key),clean={format:'slow-review-prices-1',rows:checkCandles([...(prior?.rows||[]),...value.rows]),spans:[...(prior?.spans||[]),...(value.spans||[])],source:String(value.source||''),at:Date.now(),durable:false};
      memory.set(key,clean);const db=await open();if(!db)return clean;
      const saved=await new Promise(resolve=>{try{
        const tx=db.transaction('prices','readwrite'),table=tx.objectStore('prices'),read=table.get(key);
        read.onsuccess=()=>{try{const old=read.result;clean.rows=checkCandles([...(old?.rows||[]),...clean.rows]);clean.spans=[...(old?.spans||[]),...clean.spans];clean.spans=[...new Map(clean.spans.map(s=>[s.start+'|'+s.end,s])).values()];table.put({...clean,durable:true},key);}catch{tx.abort();}};
        tx.oncomplete=()=>resolve(true);tx.onerror=tx.onabort=()=>resolve(false);
      }catch{resolve(false);}});
      clean.durable=saved;return clean;
    }
  };
}
function cacheFor(scope){if(!stores.has(scope))stores.set(scope,createReviewCache(scope));return stores.get(scope);}
export function saleReviews(entries){
  const groups=new Map(),errors=[];
  for(const qk of new Set(entries.filter(e=>e.kind==='sell').map(quoteKey))){
    try{for(const pair of fifoPairs(entries,qk).filter(p=>p.sell)){
      const g=groups.get(pair.sell.id)||{id:pair.sell.id,qk,buy:pair.buy,sell:pair.sell,quantity:pair.sell.quantity,pairs:[]};
      g.pairs.push(pair);if(pair.buy.date<g.buy.date||(pair.buy.date===g.buy.date&&pair.buy.order<g.buy.order))g.buy=pair.buy;
      groups.set(g.id,g);
    }}catch(e){errors.push(qk+'：'+e.message);}
  }
  return {groups:[...groups.values()].sort((a,b)=>b.sell.date.localeCompare(a.sell.date)||b.sell.order-a.sell.order),errors};
}
export function covered(spans,start,end){
  let cursor=day(start);const last=day(end);
  for(const s of [...spans].sort((a,b)=>a.start.localeCompare(b.start))){const a=day(s.start),b=day(s.end);if(a>cursor)return false;if(b>=cursor)cursor=b+1;if(cursor>last)return true;}
  return false;
}
export function reviewReady(data,group){
  if(!data)return false;
  try{const w=holdingWindow(data.rows,group);for(const p of group.pairs||[])if(!data.rows.some(r=>r.date===p.buy.date))return false;
    const range=requestRange(group);return !w.warnings.length||covered(data.spans||[],range.start,range.end);
  }catch{return false;}
}
function emit(scope,qk){for(const fn of listeners)fn(scope,qk);}
function online(){return globalThis.navigator?.onLine!==false&&globalThis.document?.visibilityState!=='hidden';}
export async function prepareSaleReviews(entries,{catalog={},connection={},scope,force=false,cache=cacheFor(scope),fetchHistory=loadHistory}={}){
  const {groups}=saleReviews(entries);
  for(const group of groups){
    const board=catalog[group.buy.symbol]?.board,key=scope+'|'+group.qk+'|'+board+'|'+group.buy.date+'|'+group.sell.date;
    if(work.has(key)){await work.get(key);continue;}
    const job=workQueue.catch(()=>{}).then(async()=>{
      let existing=await cache.get(group.qk);if(reviewReady(existing,group)){emit(scope,group.qk);return;}
      if(!online())return;
      if(!force&&failures.get(key)?.retryAt>Date.now())return;
      if(group.buy.market==='US'&&connection.auto===false&&!force)return;
      try{
        const fetched=await fetchHistory(group,board,connection),range=requestRange(group);
        await cache.put(group.qk,{...fetched,spans:[range]});failures.delete(key);
      }catch(e){failures.set(key,{message:e.name==='TypeError'?'暫時連不到歷史行情，已存的圖仍可查看。':e.message,retryAt:Date.now()+3600000});}
      emit(scope,group.qk);
    });
    work.set(key,job);workQueue=job;
    try{await job;}finally{work.delete(key);}
  }
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
  if(board==='TPEx')throw Error('櫃買歷史行情目前不允許網站直接跨站讀取。請展開下方「資料設定與補入」下載並匯入所需月份。');
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
  const buys=pair.pairs?.map(p=>({...p.buy,quantity:p.buyQuantity}))||[pair.buy];
  if(buys.some(b=>!data.some(r=>r.date===b.date)))throw Error('尚缺其中一批買入日行情，請補齊歷史資料');
  const prices=data.flatMap(r=>[r.high,r.low]).concat(buys.map(b=>b.price),pair.sell?.price||pair.buy.price);
  const min=Math.min(...prices),max=Math.max(...prices),pad=(max-min)*.06||max*.02||1,lo=min-pad,hi=max+pad;
  const slot=(right-left)/data.length,x=i=>left+(i+.5)*slot,y=v=>top+(hi-v)/(hi-lo)*(bottom-top),bw=Math.max(.3,Math.min(10,slot*.7));
  const grid=[lo,(lo+hi)/2,hi].map(v=>`<line x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}" stroke="#e7dacc"/><text x="${left-5}" y="${y(v)+4}" text-anchor="end" font-size="12" fill="#79695d">${new Intl.NumberFormat('zh-TW',{notation:'compact',maximumFractionDigits:2}).format(v)}</text>`).join('');
  const candles=data.map((r,i)=>{const color=r.close>=r.open?'#b72e35':'#28734b';return `<g opacity="0.38"><title>${r.date} 開 ${r.open} 高 ${r.high} 低 ${r.low} 收 ${r.close}</title><line x1="${x(i)}" x2="${x(i)}" y1="${y(r.high)}" y2="${y(r.low)}" stroke="${color}" stroke-width="${Math.min(1,slot*.7)}"/><rect x="${x(i)-bw/2}" y="${Math.min(y(r.open),y(r.close))}" width="${bw}" height="${Math.max(.7,Math.abs(y(r.open)-y(r.close)))}" fill="${color}"/></g>`;}).join('');
  const markers=[...buys.map(e=>['買入',e,'#385e7e',18]),...(pair.sell?[['賣出',pair.sell,'#865719',36]]:[])].map(([label,e,color,ty],i)=>{const px=x(data.findIndex(r=>r.date===e.date)),heading=label==='買入'&&buys.length>1?`買入 ${buys.length} 批（FIFO）`:`${label} ${e.date} · ${amount(e.price)}`;return `<g><title>${label} ${e.date} · ${amount(e.price)} · ${amount(e.quantity||pair.quantity)} 股</title><line x1="${px}" x2="${px}" y1="42" y2="${bottom+4}" stroke="${color}" stroke-width="1.8" stroke-dasharray="5 3"/><circle cx="${px}" cy="${y(e.price)}" r="4" fill="${color}"/>${i===0||label==='賣出'?`<text x="${label==='買入'?left:right}" y="${ty}" text-anchor="${label==='買入'?'start':'end'}" font-size="13" fill="${color}">${heading}</text>`:''}</g>`;}).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="FIFO 買賣日與整段持有期間日 K 線" font-family="Microsoft JhengHei, sans-serif"><title>${escape(pair.buy.symbol)} · ${escape(pair.buy.account)} · FIFO 配對 ${amount(pair.quantity)} 股；未還原日 K 線，非含費稅報酬</title><rect width="${w}" height="${h}" fill="#fffdf9"/>${grid}${candles}${markers}<text x="${left}" y="266" font-size="12" fill="#79695d">${data[0].date}</text><text x="${right}" y="266" text-anchor="end" font-size="12" fill="#79695d">${data.at(-1).date}</text></svg>`;
}

async function saveImage(svg,pair){
  const img=new Image();img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
  await img.decode();const canvas=document.createElement('canvas');canvas.width=1680;canvas.height=Math.round(1680*290/560);
  canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw Error('目前無法儲存圖檔');
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${pair.buy.symbol}-FIFO-${pair.buy.date}-${pair.sell?.date||today()}.png`;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}

export function mountSaleReviews(container,{entries,catalog={},connection={},accountName,scope,open=false,onToggle=()=>{}}){
  const {groups,errors}=saleReviews(entries),cache=cacheFor(scope);
  container.innerHTML=`<details class="review-gallery" ${open?'open':''}><summary>買賣回顧 <span class="meta">${groups.length} 筆賣出</span></summary><p class="meta" data-review-status role="status">正在整理已存的回顧…</p>${errors.map(e=>`<p class="warning">${escape(e)}</p>`).join('')}${groups.length?'<p class="meta">每筆賣出一張圖；藍線為 FIFO 配對買入，棕線為賣出，日 K 線半透明。成本與報酬算法不變。</p>':'<p class="empty">記下賣出後，會自動整理買入到賣出的完整日 K 圖。</p>'}<div class="review-cards">${groups.map((g,i)=>`<article class="review-card" data-review-card="${i}"><div class="record-top"><h3>${escape(g.sell.symbol)} ${escape(g.sell.name||'')}</h3><span class="meta">${escape(g.sell.date)} 賣出</span></div><p class="meta">${escape(accountName(g.sell.account))} · ${amount(g.quantity)} 股 · 成交 ${amount(g.sell.price)}</p><div class="trade-plot"></div><p class="meta" data-review-note>首次資料準備中，完成後直接顯示。</p><details class="more"><summary>FIFO 買入明細</summary>${g.pairs.map(p=>`<p class="meta">${escape(p.buy.date)} · 成交 ${amount(p.buy.price)} · 配對 ${amount(p.quantity)} 股${p.adjusted?'（已按配股／分割調整；原買入 '+amount(p.buyQuantity)+' 股）':''}</p>`).join('')}<p class="meta">未還原日 K 線；除權息／分割可能出現跳空，不代表投資收益。前後最多保留 3 個交易日，不補畫未發生的行情。</p></details><button class="text-link" data-review-save="${i}" type="button" disabled>儲存圖片</button></article>`).join('')}</div>${groups.length?`<details class="more"><summary>資料設定與補入</summary><p class="meta">只在本機另存歷史股價，不含 Token，不改帳本。清除網站資料會移除快取；換手機可重新取得。離線可看已備妥的圖。首次資料尚未取得時，不能憑空繪圖。</p><button class="secondary" type="button" data-review-retry>重試缺少的圖</button><p class="meta">美股背景準備需啟用 Tiingo 自動更新；上櫃因來源限制須先匯入官方資料，之後不用重匯。</p><div class="field"><label>要補入的台股<select data-review-symbol>${[...new Set(groups.filter(g=>g.buy.market==='TW').map(g=>g.qk))].map(k=>`<option value="${escape(k)}">${escape(k.slice(3))} ${escape(catalog[k.slice(3)]?.name||'')}</option>`).join('')}</select></label></div><details><summary>開啟需要的官方月份</summary><div class="history-links"></div></details><label class="field">匯入官方 JSON（可多選）<input data-review-files type="file" accept=".json,application/json" multiple></label><p class="meta" data-import-status role="status"></p></details>`:''}</details>`;
  const details=container.querySelector('.review-gallery'),cards=[...container.querySelectorAll('[data-review-card]')],records=new Map(),readyIds=new Set();
  let disposed=false;
  function paint(i){
    const g=groups[i],card=cards[i],data=records.get(g.qk),note=card.querySelector('[data-review-note]'),plot=card.querySelector('.trade-plot'),save=card.querySelector('[data-review-save]');
    if(!data){readyIds.delete(g.id);const key=scope+'|'+g.qk+'|'+catalog[g.buy.symbol]?.board+'|'+g.buy.date+'|'+g.sell.date;note.textContent=failures.get(key)?.message||(globalThis.navigator?.onLine===false?'離線中，這筆尚無本機圖表資料。':g.buy.market==='US'&&connection.auto===false?'Tiingo 自動更新已關閉；可到資料設定手動準備。':'首次正在背景補齊；完成後會直接顯示。');return;}
    try{
      const window=holdingWindow(data.rows,g);
      if(g.pairs.some(p=>!data.rows.some(r=>r.date===p.buy.date)))throw Error('尚缺其中一批買入日行情');
      if(details.open){const width=Math.round(plot.getBoundingClientRect().width)||560,stamp=data.at+'|'+data.rows.length+'|'+width;if(plot.dataset.stamp!==stamp){plot.innerHTML=tradeChartSvg(data.rows,g,width);plot.dataset.stamp=stamp;}}
      readyIds.add(g.id);
      save.disabled=false;note.textContent=`${data.source} · ${data.durable?'已存本機':'僅本次暫存（儲存空間不足或不可用）'} · ${window.rows[0].date}～${window.rows.at(-1).date}${window.warnings.length?'；'+window.warnings.join('；'):''}`;
    }catch(e){readyIds.delete(g.id);save.disabled=true;plot.innerHTML='';delete plot.dataset.stamp;note.textContent=e.message+'；可於下方補入資料。';}
  }
  function paintAll(qk){
    if(disposed)return;groups.forEach((g,i)=>{if(!qk||g.qk===qk)paint(i);});
    const ready=readyIds.size;
    container.querySelector('[data-review-status]').textContent=groups.length?`已備妥 ${ready}／${groups.length} 筆；已存的圖不需重新下載。`:'';
  }
  const update=async(s,qk)=>{if(s!==scope||disposed)return;const record=await cache.get(qk);if(disposed)return;if(record)records.set(qk,record);paintAll(qk);};
  listeners.add(update);
  details.ontoggle=()=>{onToggle(details.open);if(details.open)paintAll();};
  for(const [i,card] of cards.entries())card.querySelector('[data-review-save]').onclick=async event=>{const button=event.currentTarget;button.disabled=true;try{await saveImage(tradeChartSvg(records.get(groups[i].qk).rows,groups[i],560),groups[i]);}catch(e){card.querySelector('[data-review-note]').textContent=e.message;}finally{if(!disposed)paint(i);}};
  const retry=container.querySelector('[data-review-retry]');
  if(retry)retry.onclick=async()=>{retry.disabled=true;try{await prepareSaleReviews(entries,{catalog,connection,scope,force:true,cache});}finally{if(!disposed){retry.disabled=false;paintAll();}}};
  const picker=container.querySelector('[data-review-symbol]'),files=container.querySelector('[data-review-files]');
  function links(){
    if(!picker?.value)return;const set=new Set();
    for(const g of groups.filter(g=>g.qk===picker.value)){const r=requestRange(g);for(const m of historyMonths(r.start,r.end))set.add(m);}
    container.querySelector('.history-links').innerHTML=[...set].sort().map(m=>`<a target="_blank" rel="noopener noreferrer" href="${escape(historyUrl(picker.value.slice(3),catalog[picker.value.slice(3)]?.board,m))}">${m.slice(0,7)} ↗</a>`).join('');
  }
  if(picker){picker.onchange=links;try{links();}catch(e){container.querySelector('[data-import-status]').textContent=e.message;}}
  if(files)files.onchange=async event=>{
    const selected=[...event.target.files],qk=picker.value,board=catalog[qk?.slice(3)]?.board,status=container.querySelector('[data-import-status]');
    if(!selected.length)return;
    try{
      if(!qk)throw Error('請先選擇要補入的台股');
      if(selected.length>240||selected.reduce((n,f)=>n+f.size,0)>10000000)throw Error('檔案過大，請分批選取');
      const rows=[];for(const f of selected){const data=JSON.parse(await f.text());rows.push(...parseTaiwanHistory(data,qk.slice(3),board||(data.tables?'TPEx':'TWSE')));}
      if(disposed)return;
      const clean=checkCandles(rows);if(!clean.length)throw Error('檔案內沒有有效日 K 線');
      const saved=await cache.put(qk,{rows:clean,spans:[],source:'匯入官方格式（請自行核對來源）'});status.textContent=saved.durable?'已存入本機，下次不必重匯。':'本次可用，但無法長期儲存，請保留原檔。';emit(scope,qk);
    }catch(e){if(!disposed)status.textContent=e.message;}
  };
  // Observe container width only; inner chart height changes must not trigger a redraw loop.
  let lastWidth=0;
  const widthObserver=typeof ResizeObserver!=='undefined'?new ResizeObserver(()=>{const width=Math.round(container.getBoundingClientRect().width);if(width!==lastWidth){lastWidth=width;if(details.open)paintAll();}}):null;widthObserver?.observe(container);
  void Promise.all([...new Set(groups.map(g=>g.qk))].map(qk=>update(scope,qk))).then(()=>{if(!disposed){paintAll();void prepareSaleReviews(entries,{catalog,connection,scope,cache});}});
  return ()=>{disposed=true;listeners.delete(update);widthObserver?.disconnect();};
}
