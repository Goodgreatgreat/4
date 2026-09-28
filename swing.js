import {roundTwd,taxRounding} from './tw-fees.js';

// swing.js — related logic kept in a private scope.
export const {tickUp,swingResult,validateStrategy,validateSwing}=(()=>{
// Optional TW cash-stock planning. Never creates orders or ledger entries.
function tickUp(price){
  if(!Number.isFinite(price)||price<=0||price>1e7)throw Error('價格超出可計算範圍');
  const tick=price<10?.01:price<50?.05:price<100?.1:price<500?.5:price<1000?1:5;
  return Math.round(Math.ceil(price/tick-1e-10)*tick*100)/100;
}
function swingResult(p,price=null){
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
function validateStrategy(d){
  const mode=d.stopMode??'percent';
  if(!['percent','price'].includes(mode)||![d.trigger,d.quantity,d.sellPercent].every(Number.isFinite)||d.trigger<1||d.trigger>10||!Number.isSafeInteger(d.quantity)||d.quantity<1||d.quantity>1e8||d.sellPercent<0||d.sellPercent>=100)throw Error('請核對策略模式、R、股數與分批比例');
  if(mode==='percent'&&(!Number.isFinite(d.riskPercent)||d.riskPercent<=0||d.riskPercent>=100))throw Error('停損幅度須大於 0% 且小於 100%');
}
function validateSwing(s){
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

return {tickUp,swingResult,validateStrategy,validateSwing};
})();

// swing.js — related logic kept in a private scope.
export const {journalCharges,journalResult,validateJournals}=(()=>{

function date(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw Error('請填有效日期');}
function positive(v,label){if(!Number.isFinite(v)||v<=0||v>1e9)throw Error(label+'須為有效正數');}
function amount(v,label){if(!Number.isFinite(v)||v<0||v>1e12)throw Error(label+'須為有效非負數');}
function shares(v){positive(v,'股數');if(!Number.isSafeInteger(v))throw Error('股數須為整數');}
function journalCharges(j,price,quantity,side){
  positive(price,'價格');shares(quantity);const p=j.fees,gross=price*quantity;
  if(!Number.isFinite(gross)||gross>1e12)throw Error('成交金額超出可處理範圍');
  return {fee:roundTwd(Math.max(gross*p.rate,p.minimum),p.round),tax:side==='sell'?roundTwd(gross*p.tax,p.taxRound):0};
}
function breakEven(j,cost,quantity){
  if(!quantity)return null;
  let price=tickUp(cost/quantity),steps=0;
  while(true){const fees=journalCharges(j,price,quantity,'sell');if(price*quantity-fees.fee-fees.tax>=cost-1e-8)return price;if(++steps>200000)throw Error('費用過高，請核對股數與費用');price=tickUp(price+.001);}
}
function journalResult(j,quote=null){
  if(!j||j.type!=='journal'||typeof j.id!=='string'||!j.id||typeof j.account!=='string'||!j.account||!/^\d{4,6}$/.test(j.symbol)||typeof j.label!=='string'||j.label.length>120||typeof j.notes!=='string'||j.notes.length>4000||!Array.isArray(j.events))throw Error('波段管理資料格式不正確');
  date(j.createdDate);
  if(!['price','percent'].includes(j.stopMode)||!Number.isFinite(j.stopValue)||j.stopValue<=0||(j.stopMode==='percent'&&j.stopValue>=100)||!Number.isFinite(j.trigger)||j.trigger<1||j.trigger>10||!Number.isFinite(j.sellPercent)||j.sellPercent<0||j.sellPercent>=100||!Number.isFinite(j.trailR)||j.trailR<=0||j.trailR>20)throw Error('請核對停損、R 與分批設定');
  const f=j.fees;if(!f||![f.rate,f.minimum,f.tax].every(Number.isFinite)||f.rate<0||f.rate>.1||f.minimum<0||f.minimum>1e6||f.tax<0||f.tax>.1||!['round','floor','ceil'].includes(f.round)||!['round','floor','ceil'].includes(f.taxRound))throw Error('波段費用設定不正確');
  let quantity=0,cost=0,principal=0,totalBuyQuantity=0,totalOutlay=0,totalSellNet=0,realized=0,sold=0,lock=null,active=false,highest=0,protective=null,broker=null,lastDate=j.createdDate,closed=false;
  const ids=new Set(),rows=[];
  for(const e of j.events){
    if(!e||typeof e.id!=='string'||!e.id||ids.has(e.id))throw Error('波段操作編號無效');ids.add(e.id);date(e.date);if(e.date<lastDate)throw Error('操作日期不能早於上一筆；請依成交順序記錄');lastDate=e.date;
    if(typeof e.note!=='string'||e.note.length>2000)throw Error('操作備註過長');
    if(closed)throw Error('已結束的波段不能再新增操作，請另建計畫');
    let pnl=null;
    if(e.kind==='buy'){
      if(lock)throw Error('已鎖定原始 R；加碼請另建子計畫');
      positive(e.price,'買進價');shares(e.quantity);amount(e.fee,'買進費');
      quantity+=e.quantity;totalBuyQuantity+=e.quantity;principal+=e.price*e.quantity;cost+=e.price*e.quantity+e.fee;totalOutlay+=e.price*e.quantity+e.fee;
    }else if(e.kind==='lock'){
      if(lock||!quantity)throw Error('需先記錄買進，且只能鎖定一次');
      const entry=principal/totalBuyQuantity,stop=j.stopMode==='price'?j.stopValue:entry*(1-j.stopValue/100);
      if(stop>=entry)throw Error('初始停損須低於建倉平均買進價');
      lock={entry,stop,distance:entry-stop,quantity,target:tickUp(entry+(entry-stop)*j.trigger),date:e.date};protective=tickUp(stop);
    }else if(e.kind==='sell'){
      if(!lock)throw Error('請先確認建倉完成並鎖定原始 R，再記錄賣出');
      positive(e.price,'賣出價');shares(e.quantity);amount(e.fee,'賣出費');amount(e.tax,'交易稅');
      if(e.quantity>quantity)throw Error('賣出股數超過這筆波段剩餘股數');
      const allocated=cost*e.quantity/quantity,net=e.price*e.quantity-e.fee-e.tax;pnl=net-allocated;realized+=pnl;totalSellNet+=net;cost-=allocated;quantity-=e.quantity;sold+=e.quantity;
      if(!quantity){cost=0;closed=true;}
    }else if(e.kind==='activate'){
      if(!lock||!quantity||active)throw Error('請先鎖定 R；保本只能啟動一次');
      positive(e.price,'已確認達標價');if(e.price<lock.target)throw Error('確認價尚未達保本啟動門檻');
      if(sold<Math.floor(lock.quantity*j.sellPercent/100))throw Error('請先記錄策略要求的分批賣出成交，再啟動餘股保本');
      if(e.price<breakEven(j,cost,quantity))throw Error('確認價低於餘股費後保本價，目前無法按此價啟動保本');
      active=true;highest=e.price;
    }else if(e.kind==='high'){
      if(!active||!quantity)throw Error('先啟動保本，再更新最高價');positive(e.price,'最高價');if(e.price<highest)throw Error('已確認最高價不可降低');highest=e.price;
    }else if(e.kind==='broker'){
      if(!lock||!quantity)throw Error('請先鎖定計畫');positive(e.price,'券商停損觸發價');shares(e.quantity);if(e.quantity>quantity)throw Error('委託股數超過本波段剩餘股數');broker={price:e.price,quantity:e.quantity,date:e.date,note:e.note};
    }else if(e.kind==='cancel'){
      if(quantity)throw Error('仍有持股，請先記錄實際賣出；取消只限尚未買進計畫');closed=true;
    }else throw Error('未知波段操作');
    if(![quantity,cost,principal,totalOutlay,totalSellNet,realized].every(Number.isFinite)||quantity>1e9||Math.max(cost,principal,totalOutlay,Math.abs(totalSellNet))>1e12)throw Error('波段金額超出可處理範圍');
    if(active&&quantity)protective=tickUp(Math.max(protective,breakEven(j,cost,quantity),highest-j.trailR*lock.distance));
    rows.push({...e,pnl,afterQuantity:quantity,afterCost:cost,protective});
  }
  const average=totalBuyQuantity?principal/totalBuyQuantity:null;
  const candidateStop=average===null?null:j.stopMode==='price'?j.stopValue:average*(1-j.stopValue/100);
  const candidate=average!==null&&candidateStop<average?{entry:average,stop:candidateStop,distance:average-candidateStop,target:tickUp(average+(average-candidateStop)*j.trigger)}:null;
  const basis=lock||candidate,breakeven=breakEven(j,cost,quantity),r=quote&&Number.isFinite(quote.close)&&quote.close>0&&!quote.review&&quote.date>=lastDate&&basis?(quote.close-basis.entry)/basis.distance:null;
  const proposed=quantity?(protective??(candidate?tickUp(candidate.stop):null)):null;
  let stopOutcome=null;if(proposed&&quantity){const fees=journalCharges(j,proposed,quantity,'sell');stopOutcome=proposed*quantity-fees.fee-fees.tax-cost;}
  const brokerNeedsUpdate=!!quantity&&!!lock&&(!broker||broker.quantity!==quantity||broker.price!==proposed);
  let next=closed?'本波段已結束':!quantity?'新增第一筆買進':!lock?'繼續分批買進，或確認建倉完成鎖定 R':!active?'等待目標；分批成交後確認啟動保本':'更新已確認最高價，核對券商停損';
  if(!closed&&lock&&r!==null){if(quote.close<=proposed)next='行情已達／低於計畫停損，請核對實際委託與成交';else if(!active&&quote.close>=lock.target)next='行情已達目標；請核對分批成交與保本設定';}
  return {quantity,cost,totalBuyQuantity,totalOutlay,totalSellNet,realized,sold,average,basis,lock,active,highest,protective:proposed,stopOutcome,breakeven,broker,brokerNeedsUpdate,r,rows,lastDate,closed,stage:closed?'已結束':!lock?'建倉中':active?'保本／追蹤中':'已鎖定 R',next,partial:lock?Math.max(0,Math.floor(lock.quantity*j.sellPercent/100)-sold):null};
}
function validateJournals(list){if(list===undefined)return;if(!Array.isArray(list))throw Error('波段管理清單無效');const ids=new Set();for(const j of list){if(ids.has(j?.id))throw Error('波段管理編號重複');ids.add(j?.id);journalResult(j);}}

return {journalCharges,journalResult,validateJournals};
})();

// swing.js — related logic kept in a private scope.
export const {journalQuote,journalCards,journalCreateForm,mountJournalCreate,journalManageForm,mountJournalManage}=(()=>{
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=v=>v===null||v===undefined?'—':new Intl.NumberFormat('zh-TW',{maximumFractionDigits:4}).format(v);
const dateNow=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei'}).format(new Date());
const uid=()=>crypto.randomUUID();
const input=(name,label,value='',type='number')=>`<div class="field"><label for="journal-${name}">${esc(label)}</label><input id="journal-${name}" name="${name}" type="${type}"${type==='number'?' step="any" min="0"':''} value="${esc(value)}"></div>`;
const select=(name,label,options,value)=>`<div class="field"><label for="journal-${name}">${label}</label><select name="${name}" id="journal-${name}">${options.map(([id,label])=>`<option value="${esc(id)}"${id===value?' selected':''}>${esc(label)}</option>`).join('')}</select></div>`;
const metric=(label,value)=>`<div><dt>${label}</dt><dd>${value}</dd></div>`;
function journalQuote(j,state,catalog){const a=state.quotes['TW:'+j.symbol],b=catalog[j.symbol];return a&&(!b||a.date>=b.date)?a:b;}
function journalCards(state,account,combined,catalog){
  const js=(state.settings.swing?.journals||[]).filter(j=>combined||j.account===account);
  const card=j=>{const q=journalQuote(j,state,catalog),r=journalResult(j,q);return `<article class="record"><strong>${esc(j.symbol)} · ${esc(j.label||'波段')} · ${esc(state.accounts.find(a=>a.id===j.account)?.name||'原帳戶')}</strong><p>${r.stage} · 剩餘 ${n(r.quantity)} 股 · ${n(r.r)} R${!r.lock?'（建倉暫估）':''}</p><dl class="metrics">${metric('目標價',n(r.basis?.target))}${metric('餘股費後保本',n(r.breakeven))}${metric('計畫停損',n(r.protective))}${metric('券商已設定',r.broker?n(r.broker.price)+'／'+n(r.broker.quantity)+' 股':'未記錄')}</dl><p>${r.next}</p>${r.quantity&&r.basis&&r.breakeven>=r.basis.target?'<p class="warning">費後保本價不低於啟動目標；達標時可能還不足以保本，請核對股數、費用與門檻。</p>':''}${r.brokerNeedsUpdate?'<p class="warning">券商停損尚未記錄，或價格／股數與計畫不一致，請核對。</p>':''}<p class="meta">${q?esc(q.date)+' 收盤 '+n(q.close):'尚無行情'}；非即時，不判定盤中曾觸價。${q&&q.date<r.lastDate?'行情早於最新操作，不計目前 R。':''}</p><button class="secondary" type="button" data-journal-open="${esc(j.id)}">管理成交與追蹤</button></article>`;};
  return `<button class="primary" type="button" data-journal-new>＋ 建立分批波段管理</button>${js.filter(j=>!journalResult(j).closed).map(card).join('')}<details class="more"><summary>已結束的分批波段</summary>${js.filter(j=>journalResult(j).closed).map(card).join('')||'尚無紀錄'}</details>`;
}
function journalCreateForm(state,brokerId,seed=null){const s=state.settings.swing?.defaults||{},mode=seed?.stopMode||s.stopMode||'price';return `<form data-journal-create novalidate><p class="meta">一個計畫只包含你指定的波段成交。建立後逐筆新增買進；不會修改原帳本、現金或長期持股。實際帳務仍需另行記帳。</p>${input('symbol','股票代號',seed?.symbol||'','text')}${input('label','波段名稱',seed?seed.label+'－加碼':'','text')}${input('createdDate','計畫開始日',dateNow(),'date')}${select('stopMode','初始停損方式',[['price','支撐停損價（元）'],['percent','停損幅度（%）']],mode)}${input('stopValue','停損設定值（依上方方式填元或 %）',seed?.stopValue??(mode==='percent'?s.riskPercent??'':''))}<div class="row">${input('trigger','保本啟動門檻（R）',seed?.trigger??s.trigger??1.5)}${input('trailR','啟動後追蹤距離（原始 R）',seed?.trailR??2)}</div>${input('sellPercent','達標先賣比例（%，0 為不分批）',seed?.sellPercent??s.sellPercent??50)}${select('broker','帶入賣出預估費稅',state.brokers.map(b=>[b.id,b.name]),brokerId)}${input('notes','買進理由／停損依據','','text')}<p class="meta">費用帶入此券商目前設定並保存；每筆成交可填實付費稅。停損與 R 參數建立後固定；請先核對，未買進可取消後重建。</p><p class="error" data-journal-error role="alert" hidden></p><button class="primary" type="submit">建立波段管理</button></form>`;}
function mountJournalCreate(container,state,save){const form=container.querySelector('[data-journal-create]');form.addEventListener('submit',e=>{e.preventDefault();const error=form.querySelector('[data-journal-error]');try{const d=Object.fromEntries(new FormData(form)),broker=state.brokers.find(b=>b.id===d.broker);for(const k of ['stopValue','trigger','trailR','sellPercent'])if(d[k].trim()==='')throw Error('請完整填寫策略參數');const j={type:'journal',id:uid(),account:'pending',symbol:d.symbol.trim(),label:d.label.trim(),notes:d.notes,createdDate:d.createdDate,stopMode:d.stopMode,stopValue:Number(d.stopValue),trigger:Number(d.trigger),trailR:Number(d.trailR),sellPercent:Number(d.sellPercent),fees:{rate:broker.tw.rate*broker.tw.discount,minimum:broker.tw.min,tax:state.settings.tax.stock,round:broker.tw.round,taxRound:broker.tw.taxRound||broker.tw.round},events:[]};journalResult(j);save(j);}catch(err){error.textContent=err.message;error.hidden=false;}});}
const kinds={buy:'買進成交',sell:'賣出成交',lock:'鎖定原始 R',activate:'啟動保本',high:'更新最高價',broker:'記錄券商停損',cancel:'取消未建倉計畫'};
function actionForm(kind,fields='',button=kinds[kind]){return `<form data-journal-action="${kind}" novalidate>${input(kind+'Date','操作日期',dateNow(),'date')}${fields}${input(kind+'Note','備註','','text')}<p class="error" data-journal-error role="alert" hidden></p><button class="secondary" type="submit">${button}</button></form>`;}
function journalManageForm(j,q){const r=journalResult(j,q),basis=r.basis;let actions='';
  if(!r.closed){
    if(!r.lock){actions+=`<details class="more" open><summary>新增買進成交</summary>${actionForm('buy',`<div class="row">${input('buyPrice','買進成交價')}${input('buyQuantity','買進股數')}</div>${input('buyFee','買進手續費（留白依設定估算）')}`)}</details>`;
      if(r.quantity)actions+=`<details class="more"><summary>確認建倉完成</summary><p>目前平均買進 ${n(r.average)} 元，候選停損 ${n(basis?.stop)} 元、1R ${n(basis?.distance)} 元。確認後鎖定，不再新增買進；加碼另建子計畫。</p>${actionForm('lock')}</details>`;
      else actions+=`<details class="more"><summary>取消尚未建倉計畫</summary>${actionForm('cancel')}</details>`;
    }else{
      actions+=`<details class="more"><summary>新增賣出成交</summary>${actionForm('sell',`<div class="row">${input('sellPrice','賣出成交價')}${input('sellQuantity','賣出股數')}</div><div class="row">${input('sellFee','賣出手續費（留白依設定估算）')}${input('sellTax','交易稅（留白依設定估算）')}</div>`)}</details>`;
      if(!r.active)actions+=`<details class="more"><summary>確認啟動保本</summary><p>目標 ${n(basis.target)} 元；${r.partial?'尚需先記錄分批賣出 '+n(r.partial)+' 股。':'分批條件已滿足，或本策略不分批。'}確認價是你已觀察的達標價，不是成交保證。</p>${actionForm('activate',input('activatePrice','已確認達標價'))}</details>`;
      else actions+=`<details class="more" open><summary>更新最高價／追蹤停損</summary><p>啟動後最高價 ${n(r.highest)} 元。候選追蹤停損＝最高價－${n(j.trailR)} × 原始 1R ${n(basis.distance)} 元；與費後保本、前次計畫停損取較高者，不向下調。</p>${actionForm('high',input('highPrice','啟動後已確認最高價',r.highest))}</details>`;
      actions+=`<details class="more"><summary>記錄已在券商設定的停損</summary><p>請完成券商操作後再記錄；此按鈕不會替你送出或修改委託。可在備註記下委託有效期。</p>${actionForm('broker',`<div class="row">${input('brokerPrice','券商已設定停損觸發價')}${input('brokerQuantity','券商已設定停損股數')}</div>`)}</details><button class="text-link" type="button" data-journal-child="${esc(j.id)}">加碼：另建子計畫</button>`;
    }
  }
  return `<p class="meta">${esc(j.symbol)} · ${esc(j.label)} · ${r.stage}</p><p>${esc(j.notes)}</p><dl class="metrics">${metric('剩餘股數',n(r.quantity))}${metric('剩餘含費成本',n(r.cost))}${metric('平均買進價（不含費）',n(r.average))}${metric('已實現損益（含費稅）',n(r.realized))}${metric('原始每股 R'+(!r.lock?'（暫估）':''),n(basis?.distance))}${metric('啟動目標價',n(basis?.target))}${metric('餘股費後保本價',n(r.breakeven))}${metric('目前計畫停損',n(r.protective))}${metric('餘股於停損價成交的預估損益',n(r.stopOutcome))}${metric('券商停損紀錄',r.broker?n(r.broker.price)+' 元／'+n(r.broker.quantity)+' 股':'未記錄')}</dl><p>${r.next}</p>${r.quantity&&r.basis&&r.breakeven>=r.basis.target?'<p class="warning">費後保本價不低於啟動目標；達標時可能還不足以保本，請核對股數、費用與門檻。</p>':''}${r.brokerNeedsUpdate?'<p class="warning">券商停損價格／股數與計畫不一致或未記錄，請核對後更新。</p>':''}<p class="meta">此計畫用移動平均成本分攤每次賣出；不等於原帳本的 FIFO。餘股保本包含剩餘買進費及一次賣出費稅，不拿已實現獲利抵扣。費後為預估，跳空或滑價仍可能虧損。</p>${actions}<details class="more"><summary>成交與調整歷程（${r.rows.length} 筆）</summary>${r.rows.map(e=>`<article class="record"><strong>${esc(e.date)} · ${kinds[e.kind]}</strong><p>${e.price!==undefined?n(e.price)+' 元':''}${e.quantity!==undefined?'／'+n(e.quantity)+' 股':''}${e.fee!==undefined?' · 費 '+n(e.fee):''}${e.tax!==undefined?' · 稅 '+n(e.tax):''}${e.estimated?'（含估算費用）':''}</p><p>${e.pnl!==null?'此筆費後損益 '+n(e.pnl)+' 元 · ':''}操作後 ${n(e.afterQuantity)} 股${e.protective!==null?' · 計畫停損 '+n(e.protective):''}</p><p>${esc(e.note)}</p></article>`).join('')||'尚無操作'}${r.rows.length?'<p class="meta">填錯時可撤回最後一筆，原內容保留在設定的變更紀錄。較早錯誤須依序撤回後重填。</p><button class="text-link" type="button" data-journal-undo>撤回最後一筆操作</button><p class="error" data-journal-undo-error role="alert" hidden></p>':''}</details><p class="warning">這是本機計畫與人工確認紀錄，不會同步券商或自動新增帳本交易；日收盤行情無法取代盤中監控。最高價請按實際觀察更新。</p>`;
}
function mountJournalManage(container,j,save){
  for(const form of container.querySelectorAll('[data-journal-action]'))form.addEventListener('submit',event=>{event.preventDefault();const error=form.querySelector('[data-journal-error]');error.hidden=true;try{const d=Object.fromEntries(new FormData(form)),kind=form.dataset.journalAction,e={id:uid(),kind,date:d[kind+'Date'],note:d[kind+'Note']||''};
    if(['buy','sell','activate','high','broker'].includes(kind)){if(d[kind+'Price'].trim()==='')throw Error('請填價格');e.price=Number(d[kind+'Price']);}
    if(['buy','sell','broker'].includes(kind)){if(d[kind+'Quantity'].trim()==='')throw Error('請填股數');e.quantity=Number(d[kind+'Quantity']);}
    if(['buy','sell'].includes(kind)){const estimate=journalCharges(j,e.price,e.quantity,kind);e.fee=d[kind+'Fee'].trim()===''?estimate.fee:Number(d[kind+'Fee']);e.estimated=d[kind+'Fee'].trim()==='';if(kind==='sell'){e.tax=d.sellTax.trim()===''?estimate.tax:Number(d.sellTax);e.estimated||=d.sellTax.trim()==='';}}
    const next={...j,events:[...j.events,e]};journalResult(next);save(next,kinds[kind]);
  }catch(err){error.textContent=err.message;error.hidden=false;}});
  const undo=container.querySelector('[data-journal-undo]');if(undo)undo.onclick=()=>{try{const next={...j,events:j.events.slice(0,-1)};journalResult(next);save(next,'撤回最後一筆操作');}catch(e){const error=container.querySelector('[data-journal-undo-error]');error.textContent=e.message;error.hidden=false;}};
}

return {journalQuote,journalCards,journalCreateForm,mountJournalCreate,journalManageForm,mountJournalManage};
})();

// swing.js — related logic kept in a private scope.
export const {checkStrategy,quickResult,quickForm,mountQuick}=(()=>{
const checkStrategy=validateStrategy;
function quickResult(entry,s,broker,tax,returnPercent=3){
  checkStrategy(s);if(!Number.isFinite(entry)||entry<=0||entry>1e6||!Number.isFinite(returnPercent)||returnPercent<=-100||returnPercent>10000)throw Error('請填有效買進價與試算漲跌幅');
  const stop=(s.stopMode??'percent')==='price'?s.stopPrice:entry*(1-s.riskPercent/100);
  if(!Number.isFinite(stop)||stop<=0||stop>=entry)throw Error('支撐停損價須大於 0 且低於買進價');
  const tw=broker.tw;if(![tw.rate,tw.discount,tw.min,tax].every(Number.isFinite)||tw.rate<0||tw.discount<0||tw.min<0||tax<0||tw.rate*tw.discount>.1||tax>.1)throw Error('請核對券商費率，此試算支援費率與稅率各不超過 10%');
  const fee=g=>roundTwd(Math.max(g*tw.rate*tw.discount,tw.min),tw.round),levy=g=>roundTwd(g*tax,taxRounding(tw));
  const quantity=s.quantity,buyFee=fee(entry*quantity),outlay=entry*quantity+buyFee,target=tickUp(entry+(entry-stop)*s.trigger),partial=Math.floor(quantity*s.sellPercent/100),remaining=quantity-partial;
  const sale=(price,q=quantity)=>{const gross=price*q,sellFee=fee(gross),sellTax=levy(gross),cost=(entry+buyFee/quantity)*q,pnl=gross-sellFee-sellTax-cost;return {price,quantity:q,sellFee,sellTax,net:gross-sellFee-sellTax,pnl,rate:pnl/cost*100};};
  const cost=(entry+buyFee/quantity)*remaining;
  // Search legal ticks from the known lower bound; net is not monotone at rounded charge boundaries.
  let breakeven=tickUp(cost/remaining),steps=0;
  while(sale(breakeven,remaining).pnl < -1e-8){if(++steps>200000)throw Error('費用過高，請核對券商設定與股數');breakeven=tickUp(breakeven+.001);}
  const theoretical=entry*(1+returnPercent/100),orderPrice=tickUp(theoretical);
  return {entry,stop,riskPercent:(entry-stop)/entry*100,distance:entry-stop,target,targetPercent:(target/entry-1)*100,partial,remaining,buyFee,outlay,breakeven,breakevenPercent:(breakeven/entry-1)*100,theoretical,orderPrice,hypothetical:sale(theoretical),order:sale(orderPrice),targetSale:sale(target,partial||quantity),feeRounding:tw.round,taxRounding:taxRounding(tw)};
}
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=v=>new Intl.NumberFormat('zh-TW',{maximumFractionDigits:4}).format(v);
function quickForm(u){
  const s=u.state.settings.swing?.defaults||{riskPercent:'',trigger:1.5,quantity:1,sellPercent:50},f=u.field;
  return `<form data-swing-quick novalidate><p class="meta">先存常用策略。幅度模式填買進價；支撐價模式另填本次停損價。股數沿用預設，可按本次波段部位修改；不帶入同股票的其他持股。</p><details class="more"${u.state.settings.swing?.defaults?'':' open'}><summary>我的策略參數</summary>${f('停損設定方式','stopMode','text',s.stopMode||'percent',[['percent','停損幅度（%）'],['price','支撐停損價（元）']])}<div data-percent-stop${s.stopMode==='price'?' hidden':''}>${f('初始停損幅度（%）','riskPercent','number',s.riskPercent??'')}</div><div class="row">${f('開始保本門檻（R）','trigger','number',s.trigger)}</div><div class="row">${f('本次波段股數（2 張填 2000）','quantity','number',s.quantity)}${f('達標先賣比例（%，0 表示不分批）','sellPercent','number',s.sellPercent)}</div><p class="meta">原始 1R＝買進價－停損價；保本啟動價＝買進價＋R 倍數 × 原始 1R。支撐停損價每筆另填，不存成跨股票共用價格；請填你決定的停損觸發價，系統不另加支撐緩衝。</p><button class="secondary" type="button" data-save-strategy>儲存為常用策略</button></details>${f('本次費用券商','broker','text',u.defaultBroker(),u.state.brokers.map(b=>[b.id,b.name]))}<div class="row">${f('買進價格','entry','number','')}${f('報酬率試算：股價漲跌幅（%）','returnPercent','number',3)}</div><div data-price-stop${s.stopMode==='price'?'':' hidden'}>${f('本次支撐停損價（元）','stopPrice','number','')}</div><div data-quick-output aria-live="polite"></div><p class="error" data-quick-error role="alert" hidden></p><p class="meta" data-quick-status role="status"></p><details class="more"><summary>儲存單次買進試算（選填；分批成交請用波段管理）</summary>${f('股票代號','symbol','text','')}${f('波段名稱，例如第二筆 2 股','label','text','')}${f('買進日','entryDate','date',new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei'}).format(new Date()))}<p class="meta">同一檔可建立多筆波段，股數與買進價各自計算。這是獨立計畫，不會替帳本分配賣出批次；帳本仍依原 FIFO 計算。要獨立核算長期／波段成果，請用不同帳戶記帳。</p><button class="primary" type="submit">儲存本次波段</button></details><p class="warning">費後數字為依券商設定的預估，未含滑價，非實際成交保證。本站不下單、不盤中監控；請核對智慧單觸發價、委託價及股數。</p></form>`;
}
function mountQuick(container,u,{saveDefaults,savePlan}){
  const form=container.querySelector('[data-swing-quick]'),out=form.querySelector('[data-quick-output]'),error=form.querySelector('[data-quick-error]'),status=form.querySelector('[data-quick-status]');
  const syncMode=()=>{const isPrice=form.elements.stopMode.value==='price';form.querySelector('[data-percent-stop]').hidden=isPrice;form.querySelector('[data-price-stop]').hidden=!isPrice;};
  const read=()=>{const d=Object.fromEntries(new FormData(form)),s={stopMode:d.stopMode};for(const k of [...(d.stopMode==='percent'?['riskPercent']:[]),'trigger','quantity','sellPercent']){if(d[k].trim()==='')throw Error('請先填好策略參數');s[k]=Number(d[k]);}checkStrategy(s);return {d,s};};
  const calc=()=>{const {d,s}=read(),b=u.state.brokers.find(b=>b.id===d.broker);if(d.entry.trim()===''||d.returnPercent.trim()==='')throw Error('請填買進價格與試算漲跌幅');if(s.stopMode==='price'){if(d.stopPrice.trim()==='')throw Error('請填本次支撐停損價');s.stopPrice=Number(d.stopPrice);}return {d,s,b,r:quickResult(Number(d.entry),s,b,u.state.settings.tax.stock,Number(d.returnPercent))};};
  const preview=()=>{out.innerHTML='';error.hidden=true;const {s,r}=calc();out.innerHTML=`<section class="panel"><h3>上漲 ${n(r.targetPercent)}%（${n(r.target)} 元）開始保本</h3><p>原始 1R＝${n(r.distance)} 元（風險 ${n(r.riskPercent)}%） · ${n(s.trigger)}R · 每股上漲 ${n(r.target-r.entry)} 元 · 原始停損試算 ${n(r.stop)} 元</p><p>${r.partial?`達標先賣 ${n(r.partial)} 股，確認成交後保護剩餘 ${n(r.remaining)} 股`:'本次不分批；達標後將全數部位停損移到保本'}。</p>${s.sellPercent>0&&!r.partial?'<p class="warning">股數不足，分批股數取整後為 0，本次改顯示全數部位保本。</p>':''}<strong>費後保本價 ${n(r.breakeven)} 元（＋${n(r.breakevenPercent)}%）</strong>${r.breakeven>=r.target?'<p class="warning">費後保本價不低於啟動目標，達標時尚不足以設在此價保本；請重新檢查費用、股數或門檻。</p>':''}<hr><h3>報酬率試算</h3><p>理論價格 ${n(r.theoretical)} 元 → 可用委託參考 ${n(r.orderPrice)} 元</p><p>理論價格全數賣出：費後損益 ${n(r.hypothetical.pnl)} 元／費後報酬率 ${n(r.hypothetical.rate)}%</p><p>委託參考價全數賣出：費後損益 ${n(r.order.pnl)} 元／費後報酬率 ${n(r.order.rate)}%</p><p class="meta">以本次 ${n(s.quantity)} 股一次買進、一次全數賣出試算；報酬率分母為含買進費的支出 ${n(r.outlay)} 元。買進費 ${n(r.buyFee)}、參考價賣出費 ${n(r.order.sellFee)}、稅 ${n(r.order.sellTax)} 元。保本價另按餘股股數、分攤買進費與一次賣出費稅計算，不以已獲利部分抵扣。委託參考向上取台股個股跳動價；實際成交價可能不同。</p></section>`;return calc();};
  const run=fn=>{try{return fn();}catch(e){error.textContent=e.message;error.hidden=false;}};
  form.addEventListener('input',()=>{status.textContent='';syncMode();run(preview);});form.addEventListener('change',()=>{syncMode();run(preview);});
  form.querySelector('[data-save-strategy]').onclick=()=>run(()=>{saveDefaults(read().s);error.hidden=true;status.textContent='常用策略已儲存；支撐價模式每筆另填停損價。';});
  form.addEventListener('submit',e=>{e.preventDefault();run(()=>{const {d,s,b,r}=preview();if(!/^\d{4,6}$/.test(d.symbol.trim()))throw Error('儲存記事本需要台股個股代號');savePlan({symbol:d.symbol.trim(),label:d.label.trim(),entryDate:d.entryDate,entry:r.entry,stop:r.stop,stopMode:s.stopMode,quantity:s.quantity,trigger:s.trigger,sellPercent:s.sellPercent,buyFee:r.buyFee,feeRate:b.tw.rate*b.tw.discount,minimumFee:b.tw.min,taxRate:u.state.settings.tax.stock,feeRounding:r.feeRounding,taxRounding:r.taxRounding,sold:0,high:0,protectedStop:0,notes:'',closed:false});});});
}

return {checkStrategy,quickResult,quickForm,mountQuick};
})();

// swing.js — related logic kept in a private scope.
export const {swingSettings,swingDashboard,swingForm,mountSwing}=(()=>{
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=v=>v===null?'—':new Intl.NumberFormat('zh-TW',{maximumFractionDigits:2}).format(v);
function swingSettings(state){return `<details class="panel"><summary>擴充功能：波段交易計畫</summary><p>選用功能，預設關閉。停用保留記事本與計畫；隨帳本備份。</p><form data-form="swing-toggle"><label class="radio-line"><input name="enabled" type="checkbox"${state.settings.swing?.enabled?' checked':''}>啟用波段記事本與 R 提示</label><button class="secondary" type="submit">儲存擴充設定</button></form></details>`;}
function swingDashboard(state,account,combined=false,catalog={}){
  if(!state.settings.swing?.enabled)return '';
  const plans=state.settings.swing.plans.filter(p=>(combined||p.account===account)&&!p.closed);
  return `<section class="panel"><h2>波段交易計畫</h2><p class="meta">日收盤檢視，非盤中監控；關閉網站不會推播或下單。</p>${journalCards(state,account,combined,catalog)}<button class="secondary" type="button" data-swing-quick>策略設定／快速試算</button><button class="text-link" type="button" data-swing-new>自訂停損價記事本</button>${plans.map(p=>{
    const saved=state.quotes['TW:'+p.symbol],publicQuote=catalog[p.symbol],q=saved&&(!publicQuote||saved.date>=publicQuote.date)?saved:publicQuote,r=swingResult(p,q&&!q.review&&q.date>=p.entryDate?q.close:null);
    return `<article class="record"><strong>${esc(p.symbol)}${p.label?' · '+esc(p.label):''} · ${n(p.quantity)} 股 · ${esc(state.accounts.find(a=>a.id===p.account)?.name||'原帳戶')} · ${n(r.r)} R</strong><p>${esc(r.notice)}</p><p>＋${n(p.trigger)}R 目標 ${n(r.target)} 元 · 計畫停損 ${n(r.protective)} 元</p><p class="meta">${q?esc(q.date)+' 收盤 '+n(q.close)+' 元':'尚無收盤行情'}${q?.review?'；行情待確認，暫停 R 判讀':''}${q&&q.date<p.entryDate?'；行情早於計畫買進日，不計 R':''}。僅此行情時點，無法判斷盤中是否曾觸價。</p><button class="text-link" type="button" data-swing-edit="${esc(p.id)}">查看／更新記事本</button></article>`;
  }).join('')}<details class="more"><summary>已結束計畫</summary>${state.settings.swing.plans.filter(p=>(combined||p.account===account)&&p.closed).map(p=>`<button class="text-link" type="button" data-swing-edit="${esc(p.id)}">${esc(p.symbol)}${p.label?' · '+esc(p.label):''} · 查看記事本</button>`).join('')||'尚無紀錄'}</details></section>`;
}
function swingForm(u,p=null){
  const b=u.state.brokers.find(b=>b.id===u.defaultBroker()),f=u.field;
  const values=p||{entry:'',stop:'',quantity:'',trigger:1.5,buyFee:'',feeRate:b.tw.rate*b.tw.discount,minimumFee:b.tw.min,taxRate:u.state.settings.tax.stock,sold:0,high:0,protectedStop:0,feeRounding:b.tw.round,taxRounding:b.tw.taxRound||b.tw.round};
  const input=(label,k)=>f(label,k,'number',values[k],null,true).replace('<input ',`<input step="any" ${p&&['entry','stop','quantity','trigger'].includes(k)?'readonly ':''}`);
  return `<form data-swing-editor><input type="hidden" name="id" value="${esc(p?.id||'')}"><p class="meta">台股個股、現金一次買進。獨立計畫，不會新增買賣紀錄；加碼、分割或新一輪交易請結束舊計畫後另建。</p>${f('買進／預計買進日','entryDate','date',p?.entryDate||new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei'}).format(new Date()),null,true).replace('<input ',`<input ${p?'readonly ':''}`)}${f('股票代號','symbol','text',p?.symbol||'',null,true).replace('<input ',`<input ${p?'readonly ':''}`)}<div class="row">${input('實際／預計買進價','entry')}${input('原始停損價','stop')}</div><div class="row">${input('原始股數','quantity')}${input('分批門檻（R）','trigger')}</div><p class="meta">1R＝買進價－原始停損；儲存後固定，不隨停損上移重算。</p><div class="field"><label for="swing-notes">買進理由／停損依據／操作記事</label><textarea id="swing-notes" name="notes" rows="4" maxlength="4000">${esc(p?.notes||'')}</textarea></div><details class="more" open><summary>費用與保本試算（買進費必填）</summary><p class="meta">買進費必填，請填實付或自行預估；其餘帶入建立時券商設定。費率為小數，如 0.001425；最低費須核對零股。賣出費稅依此計畫儲存的取整設定；舊版未指定者保留進位。</p>${input('整筆買進手續費（元）','buyFee')}${input('賣出手續費率（小數）','feeRate')}${input('每次最低手續費（元）','minimumFee')}${input('賣出稅率（小數）','taxRate')}${f('手續費取整','feeRounding','text',values.feeRounding||'ceil',[['floor','捨去'],['round','四捨五入'],['ceil','進位']])}${f('交易稅取整','taxRounding','text',values.taxRounding||'ceil',[['floor','捨去'],['round','四捨五入'],['ceil','進位']])}</details><details class="more"${p?' open':''}><summary>成交後管理</summary><p class="meta">到價不代表成交。以下僅更新計畫，實際賣出仍需另外記帳。</p>${input('已確認首次分批成交股數（未成交填 0）','sold')}${input('分批成交後已確認最高價（未知填 0）','high')}<p class="meta">最高價須在分批成交後觀察；系統不會從日收盤推測盤中最高價。追蹤距離固定 2R。</p><label class="radio-line"><input name="activated" type="checkbox"${p?.activated?' checked':''}>不分批：已達門檻，確認啟動全數保本</label><label class="radio-line"><input name="closed" type="checkbox"${p?.closed?' checked':''}>結束計畫（清倉後自行勾選）</label></details><p class="error" data-swing-error role="alert" hidden></p><div class="actions"><button class="secondary" type="button" data-swing-preview>試算出場價</button><button class="primary" type="submit">儲存記事本</button></div><div data-swing-result aria-live="polite"></div><p class="warning">本站不連接券商。請在券商核對觸發價、委託價、股數、有效期與成交；保本是估算，跳空或未成交仍可能虧損。</p></form>`;
}
function mountSwing(container,old,save){
  const form=container.querySelector('[data-swing-editor]'),out=form.querySelector('[data-swing-result]'),error=form.querySelector('[data-swing-error]');
  const read=()=>{const d=Object.fromEntries(new FormData(form)),p={...old,...d,activated:!!d.activated,closed:!!d.closed,protectedStop:old?.protectedStop||0};for(const k of ['entry','stop','quantity','trigger','buyFee','feeRate','minimumFee','taxRate','sold','high']){if(d[k]?.trim()==='')throw Error('請完整填寫計畫數字');p[k]=Number(d[k]);}if(old){for(const k of ['entry','stop','quantity','trigger','symbol','entryDate'])p[k]=old[k];if(p.sold<old.sold||p.high<old.high)throw Error('已確認股數與最高價不可調低；如需更正請結束後另建計畫');}if(!/^\d{4,6}$/.test(p.symbol.trim()))throw Error('請填台股代號');p.symbol=p.symbol.trim();if(!p.sold&&!p.activated&&p.high)throw Error('尚未分批成交，最高價請填 0');if(p.sold&&p.high&&p.high<p.entry)throw Error('請核對成交後最高價');return p;};
  const preview=()=>{error.hidden=true;const p=read(),r=swingResult(p);out.innerHTML=`<section class="panel"><strong>＋${n(p.trigger)}R：${n(r.target)} 元</strong><p>原始每股 1R：${n(r.distance)} 元 · 建議首次賣 ${n(r.partial)} 股</p>${r.partial?'':'<p class="warning">僅 1 股無法分批；此計畫只供價格參考。</p>'}<p>分批成交後餘股費後保本參考：${n(swingResult({...p,sold:p.sold||r.partial}).breakeven)} 元</p><p>目前階段計畫停損：${n(r.protective)} 元 · 剩餘 ${n(r.remaining)} 股</p><p class="meta">目標／停損向上取台股個股合法跳動價。保本只分攤餘股買進費，不拿已實現獲利抵扣；未含滑價。達標後須先確認分批成交才提高餘股停損。若行情已低於新停損，請核對券商處理方式，不能視為已受保護。</p></section>`;return {...p,protectedStop:(p.sold||p.activated)?r.protective:p.protectedStop};};
  const run=fn=>{try{fn();}catch(e){error.textContent=e.message;error.hidden=false;}};
  form.querySelector('[data-swing-preview]').onclick=()=>run(preview);
  form.addEventListener('input',()=>{out.innerHTML='';error.hidden=true;});
  form.addEventListener('submit',e=>{e.preventDefault();run(()=>save(preview()));});
  if(old)run(preview);
}

return {swingSettings,swingDashboard,swingForm,mountSwing};
})();
