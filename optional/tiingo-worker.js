// Deploy to your own Cloudflare Worker only. No server-side saved tokens.
export default {
  async fetch(request,env){
    const origin=request.headers.get('Origin'),allowed=env.ALLOWED_ORIGIN;
    if(!allowed||origin!==allowed)return new Response('Origin not allowed',{status:403});
    const headers={'Access-Control-Allow-Origin':allowed,'Vary':'Origin','Cache-Control':'no-store'};
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'Authorization, Accept'}});
    if(request.method!=='GET')return new Response('Method not allowed',{status:405,headers});
    const url=new URL(request.url);
    if(!/^\/tiingo\/daily\/[A-Z][A-Z0-9.-]{0,15}\/prices$/.test(url.pathname))return new Response('Path not allowed',{status:404,headers});
    const token=request.headers.get('Authorization')||'';
    if(!/^Token [A-Za-z0-9_-]{8,512}$/.test(token))return new Response('Token required',{status:401,headers});
    const query=new URLSearchParams();
    for(const key of ['startDate','endDate']){const value=url.searchParams.get(key);if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return new Response('Date required',{status:400,headers});query.set(key,value);}
    try{
      const result=await fetch(`https://api.tiingo.com${url.pathname}?${query}`,{headers:{Authorization:token,Accept:'application/json'},signal:AbortSignal.timeout(12000)});
      return new Response(result.body,{status:result.status,headers:{...headers,'Content-Type':'application/json'}});
    }catch{return new Response('Tiingo unavailable',{status:502,headers});}
  }
};
