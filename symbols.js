// Exact exchange-code matching; keep leading zeroes and never use fuzzy prices.
export const validSymbol=(symbol,market)=>typeof symbol==='string'&&(market==='TW'?/^(?:\d{4}[A-Z]?|00[A-Z0-9]{2,6}|9\d{5})$/:/^[A-Z][A-Z0-9.-]{0,15}$/).test(symbol);
const common={AAPL:'Apple',NVDA:'NVIDIA',MSFT:'Microsoft',TSLA:'Tesla',META:'Meta',GOOG:'Alphabet',GOOGL:'Alphabet',VOO:'Vanguard S&P 500 ETF',VT:'Vanguard Total World Stock ETF',QQQ:'Invesco QQQ ETF',SPY:'SPDR S&P 500 ETF'};
export function resolveStock(raw,forced='auto',catalog={},entries=[]){
  const text=String(raw||'').normalize('NFKC').trim(),upper=text.toUpperCase();
  const match=forced==='US'?null:Object.values(catalog).find(q=>q.symbol===upper||q.name===text);
  const saved=entries.find(e=>e.symbol&&(e.symbol===upper||e.name===text)&&(forced==='auto'||e.market===forced));
  const known=Object.entries(common).find(([s,n])=>s===upper||n.toLowerCase()===text.toLowerCase());
  const symbol=match?.symbol||saved?.symbol||known?.[0]||upper;
  const market=forced==='auto'?(match?'TW':saved?.market||(/^\d/.test(symbol)?'TW':'US')):forced;
  const official=market==='TW'?catalog[symbol]:null;
  return {symbol,market,name:official?.name||saved?.name||known?.[1]||symbol,assetType:official?.type||saved?.assetType||((market==='TW'&&symbol.startsWith('00'))||['VOO','VT','QQQ','SPY'].includes(symbol)?'etf':'stock'),valid:validSymbol(symbol,market)};
}
