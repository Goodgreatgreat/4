// Application updates never clear accounting storage or reload an unfinished form.
export async function installUpdates({notify,approve}){
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
