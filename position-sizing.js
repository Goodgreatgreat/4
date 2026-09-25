import {roundTwd} from './book.js';

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
export function calculatePositionSize(input){
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
