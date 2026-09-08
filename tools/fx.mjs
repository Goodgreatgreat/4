import {writeFile,readFile,mkdir} from 'node:fs/promises';
import {SINOPAC_URL,parseSinopac,checkFx} from '../fx.js';
const file=new URL('../data/fx.json',import.meta.url);
try{
  const response=await fetch(SINOPAC_URL,{signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('HTTP '+response.status);
  const q=parseSinopac(await response.text());
  await mkdir(new URL('../data/',import.meta.url),{recursive:true});
  await writeFile(file,JSON.stringify({...q,fetchedAt:new Date().toISOString()}));
  console.log(`永豐 USD/TWD 即期牌告：${q.quotedAt}；買入 ${q.buy}，賣出 ${q.sell}。`);
}catch(error){
  // Do not turn an old quotation into a new one, or stop stock updates for an FX outage.
  try{const previous=checkFx(JSON.parse(await readFile(file,'utf8')));console.warn(`永豐更新失敗，保留 ${previous.quotedAt}：${error.message}`);}
  catch{await mkdir(new URL('../data/',import.meta.url),{recursive:true});await writeFile(file,JSON.stringify({format:'slow-sinopac-fx',status:'unavailable'}));console.warn('永豐尚無可用匯率；程式將提示手動輸入。');}
}
