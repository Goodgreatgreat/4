import {clearAppShell} from './update-utils.js';
const button=document.querySelector('#repair-update'),status=document.querySelector('#repair-status');
if(!['http:','https:'].includes(location.protocol)){button.disabled=true;}
else{
  status.textContent='只處理目前這個網站的程式快取，不會清除 localStorage 帳本。';
  button.addEventListener('click',async()=>{
    if(!confirm('請先儲存所有分頁正在輸入的內容，並建議匯出帳本備份。確定更新程式畫面？'))return;
    button.disabled=true;status.textContent='正在更新本網站的程式快取…';
    try{
      const base=new URL('./',location.href);
      await clearAppShell(base.href,globalThis.caches,navigator.serviceWorker);
      location.replace(base.href+'?updated='+Date.now()+'#entry');
    }catch(error){status.textContent='未能完成更新：'+error.message+'。不要清除瀏覽器資料；請稍後重試。';button.disabled=false;}
  });
}
