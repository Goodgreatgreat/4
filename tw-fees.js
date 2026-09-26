export function roundTwd(value,mode='round'){const nearest=Math.round(value),n=Math.abs(value-nearest)<1e-8?nearest:value;return (mode==='floor'?Math.floor:mode==='ceil'?Math.ceil:Math.round)(n);}
export const taxRounding=tw=>tw.taxRound||tw.round||'round';
