import {day} from '../book.js';
import {validSymbol} from '../symbols.js';
export function parseTwseDaily(data,date){
  day(date);
  if(data?.stat!=='OK'||data.date!==date.replaceAll('-',''))throw Error('證交所當日收盤表尚未公布');
  const table=data.tables?.find(t=>Array.isArray(t.fields)&&t.fields.includes('證券代號')&&t.fields.includes('收盤價'));
  const fields=['證券代號','證券名稱','收盤價','漲跌(+/-)','漲跌價差'];
  if(!table||!Array.isArray(table.data)||fields.some(f=>!table.fields.includes(f)))throw Error('證交所收盤表欄位已變更');
  const read=(row,name)=>String(row[table.fields.indexOf(name)]??'').trim();
  return table.data.flatMap(row=>{
    const symbol=read(row,'證券代號'),name=read(row,'證券名稱'),close=Number(read(row,'收盤價').replaceAll(',',''));
    if(!validSymbol(symbol,'TW')||!name||!Number.isFinite(close)||close<=0)return [];
    const sign=read(row,'漲跌(+/-)').replace(/<[^>]*>/g,'').trim(),amount=Number(read(row,'漲跌價差').replaceAll(',',''));
    const delta=sign==='-'?-amount:sign==='+'?amount:sign===''&&amount===0?0:NaN;
    return [{symbol,name,close,date,board:'TWSE',type:symbol.startsWith('00')?'etf':'stock',change:Number.isFinite(delta)&&close-delta>0?delta/(close-delta)*100:null,source:'證交所每日收盤表'}];
  });
}
