const PREFIX='slow-notebook-shell-'+self.registration.scope;
const CACHE=PREFIX+'v12';
const FILES=['./','./index.html','./ui.css','./main.js','./updates.js','./book.js','./cash.js','./period.js','./results.js','./trade-chart.js','./panels.js','./network.js','./quote-status.js','./fx.js','./symbols.js','./mark.svg','./manifest.json','./data/taiwan.json','./data/fx.json'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES))));
// Wait normally. Only an explicit user update action activates early.
self.addEventListener('message',event=>{
  if(event.data?.type!=='ACTIVATE_UPDATE')return;
  try{const source=new URL(event.source.url),base=new URL(self.registration.scope);if(source.origin===base.origin&&source.pathname.startsWith(base.pathname))event.waitUntil(self.skipWaiting());}catch{}
});
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith(PREFIX)&&/^[a-zA-Z0-9-]+$/.test(k.slice(PREFIX.length))&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url),base=new URL(self.registration.scope);
  if(request.method!=='GET'||url.origin!==base.origin||!url.pathname.startsWith(base.pathname))return;
  const relative=url.pathname.slice(base.pathname.length),path=relative===''?'index.html':relative;
  if(!FILES.includes('./'+path))return;
  // Only public application files and public quotes are cached. Never Token/API responses.
  const cacheKey=new URL(path,base).href;
  if(path.startsWith('data/')){
    event.respondWith(fetch(request).then(async response=>{if(!response.ok)throw Error('offline');const c=await caches.open(CACHE);await c.put(cacheKey,response.clone());return response;}).catch(()=>caches.open(CACHE).then(cache=>cache.match(cacheKey)).then(r=>r||Response.error())));
  }else event.respondWith(caches.open(CACHE).then(cache=>cache.match(cacheKey)).then(r=>r||fetch(request)));
});
