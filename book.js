import {validateCash} from './cash.js';
// Independent accounting model for 慢慢記. All rates below are decimal ratios.
export const FORMAT='slow-stock-notebook';
export const uid=()=>globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const copy=(v)=>JSON.parse(JSON.stringify(v));
export function today(){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;}
export function day(s){if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s))throw Error('日期格式不正確');const t=Date.parse(s+'T00:00:00Z');if(!Number.isFinite(t)||new Date(t).toISOString().slice(0,10)!==s)throw Error('日期不存在');return t/86400000;}
export function number(n,label,min=0){if(typeof n!=='number'||!Number.isFinite(n)||n<min)throw Error(`${label}必須是${min>0?'正':'非負'}數字`);return n;}
const positive=(n,label)=>number(n,label,Number.MIN_VALUE);
export function key(r){return JSON.stringify([r.account,r.market,r.symbol]);}
export function quoteKey(r){return `${r.market}:${r.symbol}`;}
export const moneyRound=(n,d=2)=>Math.round((n+Number.EPSILON)*10**d)/10**d;
export function emptyBook(){return {format:FORMAT,version:1,revision:0,entries:[],assets:[],classes:[],history:[],quotes:{},accounts:[{id:'main',name:'我的帳戶',broker:'standard'}],brokers:[{id:'standard',name:'我的常用券商',tw:{rate:0.001425,discount:1,min:20,round:'round'},us:{mode:'fixed',rate:0,min:0,extra:0,perShare:0,sellRate:0,sellShare:0,sellMin:0}}],settings:{account:'main',tax:{stock:.003,etf:.001,day:.0015},categories:[{id:'long',name:'長期持有'},{id:'income',name:'存股領息'},{id:'flex',name:'靈活操作'}],targets:{},tolerance:5,fx:null,monthlySeen:'',plans:{TW:{},US:{}}}};}
export function roundTwd(value,mode='round'){const nearest=Math.round(value),n=Math.abs(value-nearest)<1e-8?nearest:value;return (mode==='floor'?Math.floor:mode==='ceil'?Math.ceil:Math.round)(n);}
export function charges(entry,broker,tax){
  const gross=positive(entry.price,'成交價')*positive(entry.quantity,'股數');
  let fee=0,levy=0;
  if(entry.market==='TW'){
    const b=broker.tw;const raw=Math.max(gross*b.rate*b.discount,b.min);fee=roundTwd(raw,b.round);
    let rate=tax[entry.assetType]??tax.stock;
    if(entry.assetType==='bond')rate=entry.date>='2017-01-01'&&entry.date<='2026-12-31'?0:tax.etf;
    if(entry.assetType==='day'&&(entry.date<'2017-04-28'||entry.date>'2027-12-31'))rate=tax.stock;
    levy=entry.kind==='sell'?roundTwd(gross*rate,b.taxRound||'round'):0;
  }else{
    const b=broker.us;const base=b.mode==='share'?entry.quantity*b.rate:b.mode==='percent'?gross*b.rate:b.rate;
    fee=moneyRound(Math.max(base,b.min)+b.extra+entry.quantity*b.perShare);
    if(entry.kind==='sell')levy=moneyRound(Math.max(gross*b.sellRate+entry.quantity*b.sellShare,b.sellMin));
  }
  return {fee,tax:levy};
}
// Historical fees stay unchanged until a user confirms individual fee/tax differences.
export function queueFeeReview(b,brokerId){
  b.settings.feeReviewBrokers=[...new Set([...(b.settings.feeReviewBrokers||[]),brokerId])];
  const targets=new Map(Object.entries(b.settings.feeReviewEntryIds||{}));
  targets.set(brokerId,b.entries.filter(e=>e.broker===brokerId&&['buy','sell'].includes(e.kind)).map(e=>e.id));
  b.settings.feeReviewEntryIds=Object.fromEntries(targets);
}
export function feeReviewScope(b){return b.settings.feeReviewBrokers??b.brokers.map(x=>x.id);}
export function brokerFeeDifferences(b,brokerIds=feeReviewScope(b)){
  const ids=new Set(brokerIds),rows=[];
  for(const e of ordered(b.entries)){
    if(!ids.has(e.broker)||!['buy','sell'].includes(e.kind))continue;
    if(b.settings.feeReviewEntryIds&&Object.hasOwn(b.settings.feeReviewEntryIds,e.broker)&&!b.settings.feeReviewEntryIds[e.broker].includes(e.id))continue;
    const broker=b.brokers.find(x=>x.id===e.broker);if(!broker)continue;
    const after=charges(e,broker,b.settings.tax),fields=['fee','tax'].filter(k=>Math.abs(e[k]-after[k])>1e-8);
    if(fields.length)rows.push({entry:copy(e),broker:broker.name,after,fields});
  }
  return rows;
}
export function applyFeeReview(b,rows,selections){
  const patches=new Map(),seen=new Set();
  for(const {id,field} of selections){
    const token=JSON.stringify([id,field]);if(seen.has(token))continue;seen.add(token);
    const row=rows.find(r=>r.entry.id===id),e=b.entries.find(e=>e.id===id);
    if(!row||!e||!row.fields.includes(field)||!['fee','tax'].includes(field)||!feeReviewScope(b).includes(e.broker))throw Error('待修改項目已變更，請重新查看差異');
    if(JSON.stringify(e)!==JSON.stringify(row.entry))throw Error('交易已被修改，請重新查看差異');
    const broker=b.brokers.find(x=>x.id===e.broker),now=charges(e,broker,b.settings.tax);
    if(now[field]!==row.after[field])throw Error('券商費率已變更，請重新查看差異');
    const next=patches.get(id)||copy(e);next[field]=now[field];next[field+'Source']='broker';patches.set(id,next);
  }
  if(!patches.size)throw Error('請先勾選要修改的費用或稅費');
  const batch=uid();for(const e of patches.values()){saveEvent(b,e);b.history[0].batch=batch;b.history[0].reason='批次套用券商費稅';}
  return patches.size;
}
export function ordered(entries){return [...entries].sort((a,b)=>a.date.localeCompare(b.date)||a.order-b.order||a.id.localeCompare(b.id));}
// Hypothetical full sale, one order per account using its current default broker.
// Keep this separate from actual trades, cash balances and mark-to-market returns.
export function estimateSale(positions,state,{catalog={},date=today()}={}){
  const held=positions.filter(p=>p.quantity>0),rows=[];
  if(new Set(held.map(p=>p.market)).size>1)return {reason:'不同幣別不可直接合計賣出試算'};
  for(const p of held){
    const q=state.quotes[quoteKey(p)];
    if(!usable(q))return {reason:`${p.symbol} 尚缺股價或需確認分割`};
    const acct=state.accounts.find(a=>a.id===p.account),broker=state.brokers.find(b=>b.id===acct?.broker);
    if(!broker)return {reason:'請先設定各帳戶目前的賣出券商'};
    const last=ordered(state.entries.filter(e=>key(e)===key(p)&&['buy','sell'].includes(e.kind))).at(-1);
    let assetType=p.market==='TW'?(catalog[p.symbol]?.type||last?.assetType):'stock';
    if(assetType==='day')assetType='stock';
    if(!['stock','etf','bond'].includes(assetType))return {reason:'請先確認股票／ETF 稅別'};
    const cost=p.cost,gross=p.quantity*q.close,fees=charges({market:p.market,symbol:p.symbol,kind:'sell',quantity:p.quantity,price:q.close,date,assetType},broker,state.settings.tax);
    const net=gross-fees.fee-fees.tax,pnl=net-cost;
    if(![gross,net,pnl,fees.fee,fees.tax].every(Number.isFinite))return {reason:'賣出試算金額超出範圍'};
    rows.push({account:p.account,broker:broker.name,assetType,quantity:p.quantity,price:q.close,quoteDate:q.date,gross,cost,fee:fees.fee,tax:fees.tax,net,pnl});
  }
  const sum=k=>rows.reduce((n,r)=>n+r[k],0),cost=sum('cost'),pnl=sum('pnl');
  return {rows,cost,pnl,gross:sum('gross'),fee:sum('fee'),tax:sum('tax'),net:sum('net'),rate:cost?pnl/cost:null};
}
export function estimatePortfolioSale(positions,state,{market='mixed',catalog={},date=today()}={}){
  const held=positions.filter(p=>p.quantity>0&&(market==='mixed'||p.market===market));
  let cost=0,pnl=0;
  for(const p of held){
    const sale=estimateSale([p],state,{catalog,date});
    if(sale.reason)return {reason:sale.reason,cost:null,pnl:null,rate:null};
    const factor=market==='mixed'&&p.market==='US'?state.settings.fx?.rate:1;
    if(!Number.isFinite(factor)||factor<=0)return {reason:'缺少有效美元匯率',cost:null,pnl:null,rate:null};
    cost+=sale.cost*factor;pnl+=sale.pnl*factor;
  }
  if(!Number.isFinite(cost)||!Number.isFinite(pnl))return {reason:'試算金額超出範圍',cost:null,pnl:null,rate:null};
  return {cost,pnl,rate:cost>0?pnl/cost:null};
}
export function calculate(entries){
  const holdings=new Map(),fx=new Map(),results=[];
  for(const e of ordered(entries)){
    day(e.date);const r={...e,cash:0,pnl:0,allocated:0,dividend:0,returnRate:null};
    if(e.kind==='fxbuy'||e.kind==='fxsell'){
      const p=fx.get(e.account)||{usd:0,cost:0,realized:0};
      positive(e.usd,'美元金額');positive(e.twd,'台幣金額');number(e.fee,'換匯費用');
      if(e.kind==='fxbuy'){p.usd+=e.usd;p.cost+=e.twd+e.fee;r.actualRate=(e.twd+e.fee)/e.usd;}
      else{if(p.usd<=0||e.usd>p.usd*(1+1e-12))throw Error('這個帳戶的換匯紀錄美元不足；請先補齊先前買匯');if(e.fee>=e.twd)throw Error('換匯費用不可超過收入');r.allocated=p.cost/p.usd*Math.min(e.usd,p.usd);r.pnl=e.twd-e.fee-r.allocated;r.actualRate=(e.twd-e.fee)/e.usd;p.usd-=e.usd;p.cost-=r.allocated;p.realized+=r.pnl;}
      if(e.kind==='fxsell'&&Math.abs(p.usd)<=e.usd*1e-12){p.usd=0;p.cost=0;}for(const v of [p.usd,p.cost,p.realized,r.actualRate,r.pnl])if(!Number.isFinite(v))throw Error('換匯計算超出可處理範圍');fx.set(e.account,p);results.push(r);continue;
    }
    const k=key(e);const p=holdings.get(k)||{account:e.account,market:e.market,symbol:e.symbol,name:e.name||e.symbol,quantity:0,cost:0,realized:0,dividend:0,fees:0,lastDividend:null};
    if(e.kind==='buy'||e.kind==='sell'){
      const gross=positive(e.price,'成交價')*positive(e.quantity,'股數');number(e.fee,'手續費');number(e.tax,'稅費');
      if(e.kind==='buy'){p.cost+=gross+e.fee+e.tax;p.quantity+=e.quantity;r.cash=-gross-e.fee-e.tax;}
      else{if(p.quantity<=0||e.quantity>p.quantity*(1+1e-12))throw Error(`${e.symbol} 在 ${e.date} 此帳戶僅有 ${p.quantity} 股，不能賣出 ${e.quantity} 股`);r.allocated=p.cost/p.quantity*Math.min(e.quantity,p.quantity);r.cash=gross-e.fee-e.tax;r.pnl=r.cash-r.allocated;r.returnRate=r.allocated?r.pnl/r.allocated:null;p.quantity-=e.quantity;p.cost-=r.allocated;p.realized+=r.pnl;}
      p.fees+=e.fee+e.tax;
    }else if(e.kind==='cash'){r.cash=positive(e.amount,'實收股息');r.dividend=e.amount;p.dividend+=e.amount;p.lastDividend=e.date;}
    else if(e.kind==='stock'){p.quantity+=positive(e.quantity,'配股股數');p.lastDividend=e.date;}
    else if(e.kind==='split'){if(p.quantity<=0)throw Error('分割生效前沒有持股，請核對帳戶與日期');p.quantity*=positive(e.factor,'分割比例');}
    else throw Error('無法辨識紀錄種類');
    if(e.kind==='sell'&&Math.abs(p.quantity)<=e.quantity*1e-12){p.quantity=0;p.cost=0;}
    for(const v of [p.quantity,p.cost,p.realized,p.dividend,r.cash,r.pnl,r.allocated])if(!Number.isFinite(v))throw Error('計算超出可處理範圍，請核對金額與股數');
    r.afterQuantity=p.quantity;r.afterCost=p.cost;r.average=p.quantity?p.cost/p.quantity:0;
    p.name=e.name||p.name;holdings.set(k,p);results.push(r);
  }
  return {positions:[...holdings.values()].map(p=>({...p,average:p.quantity?p.cost/p.quantity:0})),results,fx:[...fx].map(([account,p])=>({account,...p}))};
}
function records(value,label){if(!Array.isArray(value))throw Error(`缺少完整的${label}`);const ids=new Set();for(const r of value){if(!r||typeof r!=='object'||typeof r.id!=='string'||!r.id||ids.has(r.id))throw Error(`${label}含無效／重複編號`);ids.add(r.id);}return ids;}
export function validate(b){
  if(!b||b.format!==FORMAT||b.version!==1)throw Error('這不是「慢慢記」新版備份。舊版備份不可直接覆蓋，請先保留原檔。');
  if(!Number.isSafeInteger(b.revision)||b.revision<0)throw Error('版本編號無效');
  const accounts=records(b.accounts,'帳戶');if(!accounts.size)throw Error('至少需要一個帳戶');const brokers=records(b.brokers,'券商');
  records(b.entries,'交易紀錄');records(b.assets,'資產');records(b.classes,'股票分類');records(b.history,'變更紀錄');
  if(!b.settings||!accounts.has(b.settings.account)||!b.settings.tax||!b.settings.targets)throw Error('設定不完整');
  const categories=records(b.settings.categories,'分類設定');
  if(b.settings.feeReviewBrokers!==undefined&&(!Array.isArray(b.settings.feeReviewBrokers)||b.settings.feeReviewBrokers.some(id=>typeof id!=='string'||!brokers.has(id))))throw Error('費稅差異提醒設定無效');
  if(b.settings.feeReviewEntryIds!==undefined){const targets=b.settings.feeReviewEntryIds;if(!targets||typeof targets!=='object'||Array.isArray(targets)||Object.entries(targets).some(([id,ids])=>!brokers.has(id)||!Array.isArray(ids)||ids.some(value=>typeof value!=='string')))throw Error('費稅檢查範圍無效');}
  for(const a of b.accounts){if(typeof a.name!=='string'||!a.name.trim()||!brokers.has(a.broker))throw Error('帳戶名稱或預設券商無效');}
  for(const broker of b.brokers){if(!broker.tw||!broker.us||typeof broker.name!=='string'||(!['round','floor','ceil'].includes(broker.tw.round)||(broker.tw.taxRound!==undefined&&!['round','floor','ceil'].includes(broker.tw.taxRound)))||!['fixed','share','percent'].includes(broker.us.mode))throw Error('券商設定無效');for(const k of ['rate','discount','min'])number(broker.tw[k],'台股費率');for(const k of ['rate','min','extra','perShare','sellRate','sellShare','sellMin'])number(broker.us[k],'美股費率');if(!broker.name.trim())throw Error('券商名稱不可空白');if(broker.us.mode==='percent'&&broker.us.rate>1)throw Error('百分比費率超出範圍');if(broker.tw.rate>1||broker.tw.discount>1||broker.us.sellRate>1)throw Error('費率超出範圍');}
  for(const name of ['stock','etf','day']){number(b.settings.tax[name],'稅率');if(b.settings.tax[name]>1)throw Error('稅率超出範圍');}
  for(const c of b.settings.categories){if(typeof c.name!=='string'||!c.name.trim())throw Error('分類名稱不可空白');for(const field of ['profit','loss','rise','fall']){if(c[field]!=null)number(c[field],'提醒門檻');if(c[field+'Action']&&!['buy','sell','note'].includes(c[field+'Action']))throw Error('提醒動作無效');}}
  const orderKeys=new Set();
  for(const e of b.entries){
    if(!accounts.has(e.account)||!['buy','sell','cash','stock','split','fxbuy','fxsell'].includes(e.kind))throw Error('紀錄帳戶／類型無效');
    day(e.date);if(e.date>today())throw Error('請填已發生的日期，不能預記未來成交');number(e.order,'同日順序');const orderKey=JSON.stringify([e.account,e.date,e.order]);if(orderKeys.has(orderKey))throw Error('同帳戶同一天的順序重複，請調整順序');orderKeys.add(orderKey);
    for(const k of ['feeSource','taxSource'])if(e[k]!==undefined&&!['broker','actual','unknown'].includes(e[k]))throw Error('費稅來源標記無效');
    if(!e.kind.startsWith('fx')){
      if(!['TW','US'].includes(e.market)||typeof e.symbol!=='string'||!(/^[A-Z0-9][A-Z0-9.-]{0,31}$/.test(e.symbol)))throw Error('市場或股票代號無效');
      if(['buy','sell'].includes(e.kind)&&(!brokers.has(e.broker)||!['stock','etf','bond','day'].includes(e.assetType)))throw Error('交易券商或商品類型無效');
    }
  }
  for(const a of b.assets){if(!accounts.has(a.account)||typeof a.name!=='string'||!a.name.trim()||!['TWD','USD'].includes(a.currency)||!['台股','美股','債券','現金','其他'].includes(a.bucket))throw Error('資產資料無效');day(a.date);if(a.date>today())throw Error('資產日期不可在未來');number(a.amount,'資產金額');}
  for(const c of b.classes){if(!accounts.has(c.account)||!['TW','US'].includes(c.market)||typeof c.symbol!=='string'||!['台股','美股','債券','現金','其他'].includes(c.bucket)||(c.category&&!categories.has(c.category)))throw Error('持股分類無效');}
  if(!b.quotes||typeof b.quotes!=='object'||Array.isArray(b.quotes))throw Error('行情資料無效');
  for(const q of Object.values(b.quotes)){positive(q.close,'行情價格');day(q.date);if(q.date>today())throw Error('行情日期不可在未來');}
  if(b.settings.fx){positive(b.settings.fx.rate,'估值匯率');day(b.settings.fx.date);if(b.settings.fx.date>today())throw Error('匯率日期不可在未來');}
  if(b.settings.fxMode&&!['sinopac','manual'].includes(b.settings.fxMode))throw Error('匯率模式無效');
  number(b.settings.tolerance,'容許偏差');
  for(const t of Object.values(b.settings.targets))number(t,'配置目標');
  validateCash(b);calculate(b.entries);return b;
}
export function pruneUnusedDefaults(b){
  const refs=JSON.stringify({entries:b.entries,assets:b.assets,classes:b.classes,history:b.history,cashOpenings:b.cashOpenings,cashMovements:b.cashMovements});
  const old=b.accounts.find(a=>a.id==='main'&&a.name==='我的帳戶');
  if(old&&b.accounts.length>1&&b.settings.account!==old.id&&!refs.includes(JSON.stringify(old.id)))b.accounts=b.accounts.filter(a=>a!==old);
  const broker=b.brokers.find(a=>a.id==='standard'&&a.name==='我的常用券商');
  if(broker&&b.brokers.length>1&&!b.accounts.some(a=>a.broker===broker.id)&&!refs.includes(JSON.stringify(broker.id))&&!JSON.stringify(b.settings).includes(JSON.stringify(broker.id)))b.brokers=b.brokers.filter(a=>a!==broker);
}
export class Notebook{
  constructor(storage,keyName){this.storage=storage;this.key=keyName;}
  read(){const raw=this.storage.getItem(this.key);if(raw===null)return emptyBook();let b;try{b=JSON.parse(raw);}catch{throw Error('本機資料無法解析，已停止寫入。請先下載救援檔。');}return validate(b);}
  change(edit,{expected=null}={}){const before=this.storage.getItem(this.key);const b=this.read();if(expected!==null&&b.revision!==expected)throw Error('帳本已變更，請關閉編輯視窗後重新開啟');const result=edit(b);if(result&&typeof result.then==='function')throw Error('儲存操作不可非同步');b.revision++;validate(b);if(this.storage.getItem(this.key)!==before)throw Error('另一分頁正在修改帳本，請重試');this.storage.setItem(this.key,JSON.stringify(b));return b;}
  restore(input){const b=validate(copy(input));const before=this.storage.getItem(this.key);if(before!==null)this.storage.setItem(this.key+':before-import',before);b.revision++;this.storage.setItem(this.key,JSON.stringify(b));return b;}
}
export function saveEvent(b,entry){const i=b.entries.findIndex(r=>r.id===entry.id);const before=i<0?null:b.entries[i];if(i<0)b.entries.push(entry);else b.entries[i]=entry;b.history.unshift({id:uid(),at:new Date().toISOString(),action:before?'修改':'新增',entity:'帳務',before:copy(before),after:copy(entry)});}
export function deleteEvent(b,id){const r=b.entries.find(e=>e.id===id);if(!r)throw Error('紀錄不存在');b.entries=b.entries.filter(e=>e.id!==id);b.history.unshift({id:uid(),at:new Date().toISOString(),action:'刪除',entity:'帳務',before:copy(r),after:null});}
export function xirr(flows){
  const map=new Map();for(const f of flows){const d=day(f.date);if(!Number.isFinite(f.amount))throw Error('現金流無效');map.set(d,(map.get(d)||0)+f.amount);}
  const values=[...map].sort((a,b)=>a[0]-b[0]).filter(([,v])=>Math.abs(v)>1e-9);
  if(values.length<2||!values.some(([,v])=>v<0)||!values.some(([,v])=>v>0))return {reason:'需要不同日期的投入與回收資料'};
  const days=values.at(-1)[0]-values[0][0];let turns=0;for(let i=1;i<values.length;i++)if(Math.sign(values[i][1])!==Math.sign(values[i-1][1]))turns++;
  if(turns>1)return {reason:'現金流多次正負反轉，可能沒有唯一年化解',days};
  const base=values[0][0];const sumAt=(x)=>{const logs=values.map(([d,v])=>({log:Math.log(Math.abs(v))-x*(d-base)/365,sign:Math.sign(v)}));const max=Math.max(...logs.map(v=>v.log));return logs.reduce((s,v)=>s+v.sign*Math.exp(v.log-max),0);};
  let low=-20,high=20,left=sumAt(low);if(Math.sign(left)===Math.sign(sumAt(high)))return {reason:'年化超出可靠計算範圍',days};
  for(let i=0;i<150;i++){const mid=(low+high)/2,v=sumAt(mid);if(Math.sign(v)===Math.sign(left)){low=mid;left=v;}else high=mid;}
  const log=(low+high)/2;return {rate:Math.expm1(log),period:Math.expm1(log*days/365),days};
}
export function usable(q,date=today()){return !!q&&Number.isFinite(q.close)&&q.close>0&&q.date<=date&&!q.review;}
export function performance(book,market,quotes,date=today()){
  const events=book.results.filter(r=>r.market===market),positions=book.positions.filter(p=>p.market===market&&p.quantity>0);
  const missing=positions.filter(p=>!usable(quotes[quoteKey(p)],date));if(missing.length)return {reason:`缺少可用行情：${[...new Set(missing.map(p=>p.symbol))].join('、')}`};
  const flows=events.filter(r=>r.cash!==0).map(r=>({date:r.date,amount:r.cash}));const dates=[];let value=0;
  for(const p of positions){const q=quotes[quoteKey(p)];dates.push(q.date);value+=p.quantity*q.close;}
  if(positions.length)flows.push({date,amount:value});
  return {...xirr(flows),start:flows[0]?.date,end:flows.at(-1)?.date,quoteDates:[...new Set(dates)].sort(),value};
}
export function mergePositions(positions){const map=new Map();for(const p of positions){const k=quoteKey(p),r=map.get(k)||{...p,account:'all',quantity:0,cost:0,realized:0,dividend:0,fees:0};for(const f of ['quantity','cost','realized','dividend','fees'])r[f]+=p[f];r.average=r.quantity?r.cost/r.quantity:0;if(p.lastDividend&&(!r.lastDividend||p.lastDividend>r.lastDividend))r.lastDividend=p.lastDividend;map.set(k,r);}return [...map.values()];}
export function signal(p,q,c,date=today()){if(!c||!(p.quantity>0)||!usable(q,date))return [];const rate=p.cost?(q.close*p.quantity/p.cost-1)*100:null;const tradingDate=p.market==='US'&&date===today()?new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()):date;const daily=q.date===tradingDate?q.change:null;const out=[];for(const [field,value,negative,label]of [['profit',rate,false,'獲利'],['loss',rate,true,'虧損'],['rise',daily,false,'今日上漲'],['fall',daily,true,'今日下跌']]){if(Number(c[field])>0&&Number.isFinite(value)&&(negative?-value:value)>=c[field])out.push(`${label}達 ${c[field]}%${c[field+'Action']?' · '+({buy:'買入觀察',sell:'賣出觀察',note:'留意'})[c[field+'Action']]:''}`);}return out;}
export function totalReturn(entries,market,quotes,date=today()){
  const b=calculate(entries.filter(e=>e.date<=date)),p=b.positions.filter(p=>p.market===market),held=p.filter(p=>p.quantity>0);
  const invested=b.results.filter(e=>e.market===market&&e.kind==='buy').reduce((n,e)=>n-e.cash,0);
  const realized=p.reduce((n,p)=>n+p.realized,0),dividend=p.reduce((n,p)=>n+p.dividend,0);
  const missing=held.filter(p=>!usable(quotes[quoteKey(p)],date));
  if(missing.length)return {invested,realized,dividend,reason:'缺少可用行情：'+missing.map(p=>p.symbol).join('、')};
  const unrealized=held.reduce((n,p)=>n+quotes[quoteKey(p)].close*p.quantity-p.cost,0),profit=realized+dividend+unrealized;
  return {invested,realized,dividend,unrealized,profit,rate:invested?profit/invested:null};
}
export function classifyPurchase(b,e){
  if(e.kind!=='buy')return;
  const old=b.classes.find(c=>key(c)===key(e));
  // Adding an unclassified lot must not erase a stock's existing classification.
  if(old){if(e.category)old.category=e.category;return;}
  b.classes.push({id:uid(),account:e.account,market:e.market,symbol:e.symbol,category:e.category||'',bucket:e.assetType==='bond'?'債券':e.market==='TW'?'台股':'美股'});
}
