// Cash balances are anchored at the START of a chosen date; old snapshots stay recoverable.
import {calculate,day,today,moneyRound} from './book.js';
export function dividendAmount({perShare,eligible,rate=0,fee=0,other=0,market}){
  for(const v of [perShare,eligible,rate,fee,other])if(!Number.isFinite(v)||v<0)throw Error('股利設定須為非負數');
  if(perShare<=0||eligible<=0||rate>1)throw Error('請核對每股股利、配息股數及扣款比例');
  const digits=market==='TW'?0:2,gross=moneyRound(perShare*eligible,digits),withheld=moneyRound(gross*rate,digits),net=moneyRound(gross-withheld-fee-other,digits);
  if(!Number.isFinite(net)||net<=0)throw Error('淨股利須大於 0，請核對扣款');
  return {gross,withheld,net,fee,other,perShare,eligible,rate};
}
export function cashBalances(b,date=today()){
  const events=calculate(b.entries.filter(e=>e.date<=date)).results;
  return (b.cashOpenings||[]).filter(o=>o.date<=date).map(o=>{
    let amount=o.amount;
    for(const e of events.filter(e=>e.account===o.account&&e.date>=o.date)){
      if(e.kind==='fxbuy')amount+=o.currency==='USD'?e.usd:-e.twd-e.fee;
      else if(e.kind==='fxsell')amount+=o.currency==='USD'?-e.usd:e.twd-e.fee;
      else if((e.market==='TW'?'TWD':'USD')===o.currency)amount+=e.cash;
    }
    for(const e of (b.cashMovements||[]).filter(e=>e.account===o.account&&e.currency===o.currency&&e.date>=o.date&&e.date<=date))amount+=(e.direction==='in'?1:-1)*e.amount;
    return {...o,opening:o.amount,amount:moneyRound(amount,2),date,openingDate:o.date};
  });
}
export function validateCash(b){
  const accounts=new Set(b.accounts.map(a=>a.id)),pairs=new Set();
  for(const name of ['cashOpenings','cashMovements']){
    if(b[name]===undefined)continue;
    if(!Array.isArray(b[name]))throw Error('現金帳格式無效');
    const ids=new Set();for(const r of b[name]){
      if(!r||typeof r.id!=='string'||!r.id||ids.has(r.id)||!accounts.has(r.account)||!['TWD','USD'].includes(r.currency))throw Error('現金帳資料無效');
      ids.add(r.id);day(r.date);if(r.date>today()||!Number.isFinite(r.amount)||r.amount<0)throw Error('現金日期或金額無效');
      if(name==='cashOpenings'){const k=JSON.stringify([r.account,r.currency]);if(pairs.has(k))throw Error('同帳戶同幣別只能有一筆期初現金');pairs.add(k);}
      else if(!['in','out'].includes(r.direction)||r.amount<=0)throw Error('存提款資料無效');
    }
  }
  for(const e of b.entries)if(e.dividend){if(e.kind!=='cash'||!b.brokers.some(x=>x.id===e.broker))throw Error('股利紀錄券商或類型無效');const r=dividendAmount({...e.dividend,market:e.market});if(Math.abs(r.net-e.amount)>.000001)throw Error('股利淨額與扣款明細不一致');if(e.exDate){day(e.exDate);if(e.exDate>e.date)throw Error('除息日不可晚於發放日');}}
  for(const broker of b.brokers)for(const p of Object.values(broker.dividends||{}))if(!p||!Number.isFinite(p.rate)||p.rate<0||p.rate>1||!Number.isFinite(p.fee)||p.fee<0)throw Error('股利扣款設定無效');
}
