const PREFIX='slow-notebook-shell-'+self.registration.scope;
const CACHE=PREFIX+'v1';
const FILES=['./','./index.html','./ui.css','./main.js','./book.js','./panels.js','./network.js','./symbols.js','./mark.svg','./manifest.json','./data/taiwan.json'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES))));
// Updates activate after all old tabs close, so modules cannot mix versions.
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith(PREFIX)&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url),base=new URL(self.registration.scope);
  if(request.method!=='GET'||url.origin!==base.origin||!url.pathname.startsWith(base.pathname))return;
  const relative=url.pathname.slice(base.pathname.length),path=relative===''?'index.html':relative;
  if(!FILES.includes('./'+path))return;
  // Only public application files and public quotes are cached. Never Token/API responses.
  const cacheKey=new URL(path,base).href;
  if(path==='data/taiwan.json'){
    event.respondWith(fetch(request).then(async response=>{if(!response.ok)throw Error('offline');const c=await caches.open(CACHE);await c.put(cacheKey,response.clone());return response;}).catch(()=>caches.match(cacheKey).then(r=>r||Response.error())));
  }else event.respondWith(caches.match(cacheKey).then(r=>r||fetch(request)));
});
