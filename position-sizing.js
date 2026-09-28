import {roundTwd} from './book.js';

// position-sizing.js — related logic kept in a private scope.
export const {calculatePositionSize}=(()=>{

const MAX_SAFE=Number.MAX_SAFE_INTEGER;
const ROUNDING=new Set(['round','floor','ceil']);
// Match the ledger's tolerance for decimal floating-point noise at money boundaries.
const EPSILON=1e-8;

function numeric(value,label,{positive=false,rate=false}={}){
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||(positive&&value===0))throw new Error(`${label}必須是${positive?'正':'非負'}數字`);
  if(value>MAX_SAFE||(rate&&value>1))throw new Error(`${label}超出可計算範圍`);
  return value;
}
function safe(value){
  if(!Number.isFinite(value)||Math.abs(value)>MAX_SAFE)throw new Error('金額或股數超出安全計算範圍，請縮小試算數字');
  return value;
}
const within=(amount,limit)=>amount<=limit||amount-limit<=Math.min(EPSILON,4*Number.EPSILON*Math.max(Math.abs(amount),Math.abs(limit)));

/**
 * Cash-only Taiwan long position sizing, one buy and one complete stop sale.
 * This pure estimate never creates a trade or changes a ledger/broker setting.
 * Fee/tax rates are decimal ratios; slippage is TWD per share below stopPrice.
 * The stop is a planning trigger, not a promise of execution or maximum loss.
 */
function calculatePositionSize(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('請填寫完整試算條件');
  const {
    entryPrice,stopPrice,riskBudget,capital,feeRate,minimumFee,sellTaxRate,
    feeRounding='round',taxRounding='round',slippage=0,lotSize=1
  }=input;
  for(const [value,label] of [[entryPrice,'預計買進價'],[stopPrice,'停損觸發價'],[riskBudget,'單筆損失預算'],[capital,'可投入金額']])numeric(value,label,{positive:true});
  numeric(feeRate,'手續費率',{rate:true});numeric(minimumFee,'最低手續費');numeric(sellTaxRate,'賣出交易稅率',{rate:true});numeric(slippage,'每股滑價預留');
  if(!ROUNDING.has(feeRounding)||!ROUNDING.has(taxRounding))throw new Error('費稅取整方式不正確');
  if(lotSize!==1&&lotSize!==1000)throw new Error('股數單位只能選 1 股或 1,000 股');
  if(stopPrice>=entryPrice)throw new Error('停損觸發價必須低於預計買進價');
  const executionPrice=stopPrice-slippage;
  if(executionPrice<=0)throw new Error('停損價扣除滑價後必須大於 0');
  const riskPerShare=entryPrice-executionPrice;
  const quote=quantity=>{
    if(!Number.isSafeInteger(quantity)||quantity<0)throw new Error('股數超出安全計算範圍');
    const buyGross=safe(quantity*entryPrice),sellGross=safe(quantity*executionPrice);
    // Identical fee ordering to book.js charges(): minimum first, then TWD rounding.
    // No order means no minimum fee, including when no shares fit either budget.
    const buyFee=quantity?roundTwd(Math.max(buyGross*feeRate,minimumFee),feeRounding):0;
    const sellFee=quantity?roundTwd(Math.max(sellGross*feeRate,minimumFee),feeRounding):0;
    const sellTax=quantity?roundTwd(sellGross*sellTaxRate,taxRounding):0;
    const priceLoss=safe(quantity*riskPerShare),totalFees=safe(buyFee+sellFee+sellTax);
    const buyOutlay=safe(buyGross+buyFee),sellNet=safe(sellGross-sellFee-sellTax);
    const estimatedLoss=safe(priceLoss+totalFees);
    return {quantity,priceLoss,buyGross,buyFee,buyOutlay,sellGross,sellFee,sellTax,sellNet,totalFees,estimatedLoss};
  };
  const fits=q=>within(q.estimatedLoss,riskBudget)&&within(q.buyOutlay,capital);
  // Rounding upward avoids dropping a possible final lot due to division noise.
  // Both constraints are monotone, even across minimum-fee and rounding steps.
  let low=0,high=Math.ceil(capital/entryPrice/lotSize);
  if(!Number.isSafeInteger(high)||high>Math.floor(MAX_SAFE/lotSize)-1)throw new Error('股數超出安全計算範圍，請縮小試算數字');
  while(low<high){
    const mid=low+Math.ceil((high-low)/2);
    if(fits(quote(mid*lotSize)))low=mid;else high=mid-1;
  }
  const result=quote(low*lotSize),next=quote((low+1)*lotSize),oneLot=quote(lotSize);
  const riskLimited=!within(next.estimatedLoss,riskBudget),capitalLimited=!within(next.buyOutlay,capital);
  return {
    ...result,entryPrice,stopPrice,executionPrice,riskPerShare,lotSize,
    unusedCapital:Math.max(0,capital-result.buyOutlay),riskRemaining:Math.max(0,riskBudget-result.estimatedLoss),
    limitingFactor:riskLimited&&capitalLimited?'both':riskLimited?'risk':'capital',
    nextQuantity:next.quantity,nextLoss:next.estimatedLoss,nextOutlay:next.buyOutlay,
    oneLotLoss:oneLot.estimatedLoss,oneLotOutlay:oneLot.buyOutlay
  };
}

return {calculatePositionSize};
})();

// position-sizing.js — related logic kept in a private scope.
export const {positionSizingContent,mountPositionSizing}=(()=>{

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=value=>new Intl.NumberFormat('zh-TW',{maximumFractionDigits:6}).format(value);
const amount=value=>'NT$ '+new Intl.NumberFormat('zh-TW',{minimumFractionDigits:2,maximumFractionDigits:2}).format(value);
const labels={entryPrice:'預計買進價',stopPrice:'停損觸發價',riskBudget:'單筆預計虧損上限',capital:'本筆可用資金',feeRate:'折扣後手續費率',minimumFee:'每次最低手續費',sellTaxRate:'賣出交易稅率',slippage:'每股滑價預留'};
function input(name,label,value=''){
  return `<div class="field"><label for="sizing-${name}">${label}</label><input id="sizing-${name}" name="${name}" type="number" min="0" step="any" inputmode="decimal" value="${esc(value)}"></div>`;
}
function select(name,label,choices,value){
  return `<div class="field"><label for="sizing-${name}">${label}</label><select id="sizing-${name}" name="${name}">${choices.map(([id,text])=>`<option value="${esc(id)}"${String(id)===String(value)?' selected':''}>${esc(text)}</option>`).join('')}</select></div>`;
}
function profile(state,brokerId){
  const broker=state.brokers.find(b=>b.id===brokerId)||state.brokers[0];
  return {broker,feeRate:Number((broker.tw.rate*broker.tw.discount*100).toPrecision(12)),minimumFee:broker.tw.min,sellTaxRate:Number((state.settings.tax.stock*100).toPrecision(12)),feeRounding:broker.tw.round,taxRounding:broker.tw.taxRound||broker.tw.round};
}
function positionSizingContent(state,brokerId){
  const p=profile(state,brokerId),rounds=[['round','四捨五入至元'],['floor','無條件捨去至元'],['ceil','無條件進位至元']];
  return `<form data-position-sizing novalidate>
    <p class="meta">台股現金買進試算。金額皆為新台幣；只計算股數，不會建立交易或下單。</p>
    <div class="row">${input('entryPrice','預計買進價（每股）')}${input('stopPrice','停損觸發價（每股）')}</div>
    <div class="row">${input('riskBudget','單筆預計虧損上限（含費稅）')}${input('capital','本筆可用資金（含買進費）')}</div>
    <div class="row">${select('sizingBroker','帶入券商費用',state.brokers.map(b=>[b.id,b.name]),p.broker.id)}${select('lotSize','買進單位',[[1,'以 1 股為單位'],[1000,'以 1 張（1,000 股）為單位']],1)}</div>
    <details class="more sizing-fees"><summary>費稅與成交設定</summary>
      <p class="meta">以下調整僅供本次試算。切換券商會重新帶入費率與取整方式；請核對零股最低費用及個股／ETF 稅率。</p>
      <div class="row">${input('feeRate','折扣後手續費率（%）',p.feeRate)}${input('minimumFee','每次最低手續費（元）',p.minimumFee)}</div>
      <div class="row">${input('sellTaxRate','賣出交易稅率（%）',p.sellTaxRate)}${input('slippage','每股滑價預留（元）',0)}</div>
      <div class="row">${select('feeRounding','手續費取整',rounds,p.feeRounding)}${select('taxRounding','交易稅取整',rounds,p.taxRounding)}</div>
      <p class="meta">預估停損成交價＝停損觸發價－每股滑價預留。預設 0，表示假設恰好在觸發價成交。</p>
    </details>
    <p class="error" data-sizing-error role="alert" tabindex="-1" hidden></p>
    <button class="primary" type="submit">計算可買股數</button>
    <p class="meta" data-sizing-status role="status" hidden></p>
    <div data-sizing-result tabindex="-1" aria-label="股數試算結果" hidden></div>
    <p class="warning">按一次買進、一次全數停損估算。分批或拆單需另計費用；跳空、滑價或未成交，可能使實際損失超過上限。本工具不判斷停損位置是否合適。</p>
  </form>`;
}
function resultContent(r){
  const reason={risk:'虧損預算',capital:'可用資金',both:'虧損預算與可用資金'}[r.limitingFactor];
  if(!r.quantity)return `<section class="panel sizing-result"><p class="sizing-caption">符合目前條件的股數</p><strong class="sizing-quantity">0 股</strong><p>目前${reason}不足以買進 ${number(r.lotSize)} 股。</p><dl class="metrics"><div><dt>${number(r.lotSize)} 股所需買進支出</dt><dd>${amount(r.oneLotOutlay)}</dd></div><div><dt>${number(r.lotSize)} 股預計停損損失</dt><dd>${amount(r.oneLotLoss)}</dd></div></dl><p class="meta">可以保留資金，不必為了買進而縮短停損距離。</p></section>`;
  return `<section class="panel sizing-result"><p class="sizing-caption">符合目前條件的最多股數</p><strong class="sizing-quantity">${number(r.quantity)} <small>股</small></strong>
    <dl class="metrics"><div><dt>買進總支出（含費）</dt><dd>${amount(r.buyOutlay)}</dd></div><div><dt>預計停損總損失（含費稅）</dt><dd>${amount(r.estimatedLoss)}</dd></div><div><dt>未使用資金</dt><dd>${amount(r.unusedCapital)}</dd></div><div><dt>虧損預算餘額</dt><dd>${amount(r.riskRemaining)}</dd></div></dl>
    <p class="meta">限制來自${reason}；若買 ${number(r.nextQuantity)} 股，需支出 ${amount(r.nextOutlay)}，預計停損損失 ${amount(r.nextLoss)}。</p>
    <details class="more"><summary>查看計算明細</summary><dl class="metrics"><div><dt>預估停損成交價</dt><dd>NT$ ${number(r.executionPrice)}</dd></div><div><dt>停損價差損失</dt><dd>${amount(r.priceLoss)}</dd></div><div><dt>買進手續費</dt><dd>${amount(r.buyFee)}</dd></div><div><dt>賣出手續費</dt><dd>${amount(r.sellFee)}</dd></div><div><dt>賣出交易稅</dt><dd>${amount(r.sellTax)}</dd></div><div><dt>停損後預計淨收款</dt><dd>${amount(r.sellNet)}</dd></div></dl>
      <p class="meta">預計損失＝股數 ×（買進價－預估停損成交價）＋買進手續費＋賣出手續費＋交易稅。每次手續費取成交金額 × 費率與最低費用的較高者，再依設定取整。</p>
    </details></section>`;
}
function mountPositionSizing(container,state){
  const form=container.querySelector('[data-position-sizing]'),result=form.querySelector('[data-sizing-result]'),error=form.querySelector('[data-sizing-error]'),status=form.querySelector('[data-sizing-status]');
  const invalidate=()=>{if(!result.hidden){status.textContent='條件已變更，請重新試算。';status.hidden=false;}result.hidden=true;error.hidden=true;};
  form.addEventListener('input',invalidate);
  form.addEventListener('change',event=>{
    if(event.target.name==='sizingBroker'){
      const p=profile(state,event.target.value);
      for(const name of ['feeRate','minimumFee','sellTaxRate','feeRounding','taxRounding'])form.elements.namedItem(name).value=p[name];
    }
    invalidate();
  });
  form.addEventListener('submit',event=>{
    event.preventDefault();
    result.hidden=true;error.hidden=true;status.hidden=true;
    try{
      const values={};
      for(const [name,label] of Object.entries(labels)){
        const value=form.elements.namedItem(name).value.trim();
        if(value===''||!Number.isFinite(Number(value)))throw Error('請填寫有效的'+label+'。');
        values[name]=Number(value);
      }
      values.feeRate/=100;values.sellTaxRate/=100;
      values.feeRounding=form.elements.namedItem('feeRounding').value;values.taxRounding=form.elements.namedItem('taxRounding').value;values.lotSize=Number(form.elements.namedItem('lotSize').value);
      const calculated=calculatePositionSize(values);
      result.innerHTML=resultContent(calculated);result.hidden=false;result.focus({preventScroll:true});result.scrollIntoView({block:'nearest'});
    }catch(e){error.textContent=e.message;error.hidden=false;error.focus({preventScroll:true});error.scrollIntoView({block:'nearest'});}
  });
}

return {positionSizingContent,mountPositionSizing};
})();
