import {roundTwd} from './tw-fees.js';
import {tickUp} from './swing.js';

function date(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw Error('請填有效日期');}
function positive(v,label){if(!Number.isFinite(v)||v<=0||v>1e9)throw Error(label+'須為有效正數');}
function amount(v,label){if(!Number.isFinite(v)||v<0||v>1e12)throw Error(label+'須為有效非負數');}
function shares(v){positive(v,'股數');if(!Number.isSafeInteger(v))throw Error('股數須為整數');}
export function journalCharges(j,price,quantity,side){
  positive(price,'價格');shares(quantity);const p=j.fees,gross=price*quantity;
  if(!Number.isFinite(gross)||gross>1e12)throw Error('成交金額超出可處理範圍');
  return {fee:roundTwd(Math.max(gross*p.rate,p.minimum),p.round),tax:side==='sell'?roundTwd(gross*p.tax,p.taxRound):0};
}
function breakEven(j,cost,quantity){
  if(!quantity)return null;
  let price=tickUp(cost/quantity),steps=0;
  while(true){const fees=journalCharges(j,price,quantity,'sell');if(price*quantity-fees.fee-fees.tax>=cost-1e-8)return price;if(++steps>200000)throw Error('費用過高，請核對股數與費用');price=tickUp(price+.001);}
}
export function journalResult(j,quote=null){
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
export function validateJournals(list){if(list===undefined)return;if(!Array.isArray(list))throw Error('波段管理清單無效');const ids=new Set();for(const j of list){if(ids.has(j?.id))throw Error('波段管理編號重複');ids.add(j?.id);journalResult(j);}}
