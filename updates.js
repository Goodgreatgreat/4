// Application updates never clear accounting storage or reload an unfinished form.
export async function installUpdates({notify,approve}){
  showReleaseSummary();
  if(!['https:','http:'].includes(location.protocol)||!('serviceWorker' in navigator))return;
  const banner=document.querySelector('#update-banner'),button=document.querySelector('#apply-update');
  const hadController=!!navigator.serviceWorker.controller;
  let requested=false,lastCheck=0;
  try{
    const registration=await navigator.serviceWorker.register('./offline.js',{updateViaCache:'none'});
    const show=()=>{banner.hidden=false;};
    if(registration.waiting)show();
    registration.addEventListener('updatefound',()=>{
      const worker=registration.installing;
      worker?.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)show();});
    });
    navigator.serviceWorker.addEventListener('controllerchange',()=>{
      if(requested)location.reload();else if(hadController)show();
    });
    button.addEventListener('click',()=>{
      if(!approve())return;
      requested=true;button.disabled=true;
      if(registration.waiting)registration.waiting.postMessage({type:'ACTIVATE_UPDATE'});else location.reload();
    });
    const check=async(force=false)=>{
      if(!navigator.onLine||(!force&&Date.now()-lastCheck<3600000))return;
      lastCheck=Date.now();try{await registration.update();if(registration.waiting)show();}catch{if(force)notify('目前無法檢查更新，稍後再試。');}
    };
    document.querySelector('#check-update').addEventListener('click',async()=>{
      await check(true);if(!registration.waiting&&!registration.installing)notify('已檢查已發布的程式版本；若仍顯示舊畫面，可使用更新修復頁。');
    });
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void check();});
    window.addEventListener('online',()=>void check());
    void check();
  }catch{notify('暫時無法啟用離線更新；連網記帳仍可使用。');}
}
export const RELEASE_SUMMARY={version:'1.4.23',text:'重新分清股票風格與投資工具、資產股債現金兩篇文章；加入需要／能力／意願，各篇文末附來源，股票新預設改核心／自選示例，自訂不變。'};
export function showReleaseSummary(){
  const key='slow-notebook-release:'+new URL('.',location.href).pathname;
  try{if(localStorage.getItem(key)===RELEASE_SUMMARY.version)return;}catch{}
  if(document.querySelector('#release-summary'))return;
  const box=document.createElement('section');box.id='release-summary';box.className='panel';box.setAttribute('aria-label','本次更新');
  const title=document.createElement('strong');title.textContent='已更新 '+RELEASE_SUMMARY.version;
  const text=document.createElement('p');text.textContent=RELEASE_SUMMARY.text;
  const close=document.createElement('button');close.type='button';close.className='text-link';close.textContent='知道了';
  close.addEventListener('click',()=>{box.remove();try{localStorage.setItem(key,RELEASE_SUMMARY.version);}catch{}});
  box.append(title,text,close);document.querySelector('main')?.before(box);
}
