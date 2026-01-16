export const normalizeCNPJNumeric = (s='') => String(s).replace(/\D/g,'');
export function formatCNPJMask(digits14){
  const s = String(digits14||''); if (s.length!==14) return null;
  return `${s.slice(0,2)}.${s.slice(2,5)}.${s.slice(5,8)}/${s.slice(8,12)}-${s.slice(12,14)}`;
}
export function isValidCNPJ(cnpj){
  const s = normalizeCNPJNumeric(cnpj);
  if (s.length!==14 || /^(\d)\1{13}$/.test(s)) return false;
  const calc=d=>{let sum=0,w=2;for(let i=d.length-1;i>=0;i--){sum+=Number(d[i])*w;w=(w===9)?2:w+1;}const m=sum%11;return m<2?0:11-m;};
  const d1=calc(s.slice(0,12)); const d2=calc(s.slice(0,12)+d1); return s.endsWith(`${d1}${d2}`);
}
