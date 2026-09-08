// Shared GitHub origin can contain other repositories: never clear origin-wide storage.
export async function clearAppShell(baseUrl,cacheStorage,workers){
  const base=new URL(baseUrl),within=value=>{try{const u=new URL(value);return u.origin===base.origin&&u.pathname.startsWith(base.pathname);}catch{return false;}};
  if(workers){
    for(const registration of await workers.getRegistrations()){
      if(registration.scope!==base.href)continue;
      const script=registration.active?.scriptURL||registration.waiting?.scriptURL||registration.installing?.scriptURL;
      if(script&&within(script)&&['offline.js','sw.js'].includes(new URL(script).pathname.split('/').at(-1)))await registration.unregister();
    }
  }
  if(!cacheStorage)return;
  const scopedPrefix='slow-notebook-shell-'+base.href;
  const legacyFiles=new Set(['','index.html','app.js','ledger.js','storage.js','performance.js','tiingo.js','tw-quotes.js','styles.css','icon.svg','manifest.webmanifest','data/tw-quotes.json']);
  for(const name of await cacheStorage.keys()){
    if(name.startsWith(scopedPrefix)&&/^[a-zA-Z0-9-]+$/.test(name.slice(scopedPrefix.length)))await cacheStorage.delete(name);
    else if(name.startsWith('stock-journal-shell-')){
      const cache=await cacheStorage.open(name);
      for(const request of await cache.keys())if(within(request.url)&&legacyFiles.has(new URL(request.url).pathname.slice(base.pathname.length)))await cache.delete(request);
      if(!(await cache.keys()).length)await cacheStorage.delete(name);
    }
  }
}
