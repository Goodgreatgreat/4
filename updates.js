// Application updates never clear accounting storage or reload an unfinished form.
export async function installUpdates({notify,approve}){
  if(!['https:','http:'].includes(location.protocol)||!('serviceWorker' in navigator))return;
  const banner=document.querySelector('#update-banner'),button=document.querySelector('#apply-update');
  const hadController=!!navigator.serviceWorker.controller;
  let requested=false,lastCheck=0;
  try{
    const registration=await navigator.serviceWorker.register('./offline.js',{updateViaCache:'none'});
    let shownWorker=null;
    const show=async()=>{
      const worker=registration.waiting||navigator.serviceWorker.controller;
      if(!worker)return;
      shownWorker=worker;banner.hidden=false;
      renderUpdateSummary(banner,null);
      const summary=await requestUpdateSummary(worker);
      if(shownWorker!==worker||(registration.waiting||navigator.serviceWorker.controller)!==worker)return;
      renderUpdateSummary(banner,summary);
    };
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
export const RELEASE_SUMMARY={"version":"1.4.31","items":["新增分批波段管理：逐筆買賣、鎖定原始 R、保本與最高價追蹤。","分開記錄計畫停損與券商已設定停損，提示價格及股數差異；保留操作歷程與撤回。"]};
export function validReleaseSummary(value){
  return !!value&&/^\d+\.\d+\.\d+$/.test(value.version)&&Array.isArray(value.items)&&value.items.length>0&&value.items.length<=8&&value.items.every(s=>typeof s==='string'&&s.trim()&&s.length<=200);
}
export function requestUpdateSummary(worker){
  return new Promise(resolve=>{
    const channel=new MessageChannel();let timer;
    const finish=value=>{clearTimeout(timer);channel.port1.close();channel.port2.close();resolve(value);};
    timer=setTimeout(()=>finish(null),3000);
    channel.port1.onmessage=e=>finish(validReleaseSummary(e.data)?e.data:null);
    try{worker.postMessage({type:'GET_RELEASE_SUMMARY'},[channel.port2]);}catch{finish(null);}
  });
}
export function renderUpdateSummary(banner,summary){
  let box=banner.querySelector('.update-description');
  if(!box){box=document.createElement('div');box.className='update-description';banner.querySelector('span')?.remove();banner.prepend(box);}
  box.replaceChildren();
  const title=document.createElement('strong');title.textContent=summary?'新版 '+summary.version+'：這次更新':'有新版程式';
  box.append(title);
  if(summary){const list=document.createElement('ul');for(const item of summary.items){const li=document.createElement('li');li.textContent=item;list.append(li);}box.append(list);}
  else{const p=document.createElement('p');p.textContent='暫時無法讀取新版說明；不以舊版內容代替。';box.append(p);}
  const note=document.createElement('p');note.textContent='請先儲存正在輸入的內容，再按「套用新版」。';box.append(note);
}
