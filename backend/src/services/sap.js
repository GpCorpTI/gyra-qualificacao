import https from 'https';
import axios from 'axios';
import { SAP } from '../config/env.js';

const sapHttpsAgent = new https.Agent({ rejectUnauthorized: false });

export async function sapCreateSession(){
  const payload = { CompanyDB: SAP.companyDb, UserName: SAP.user, Password: SAP.pass };
  const resp = await axios.post(`${SAP.base}/Login`, payload, { httpsAgent: sapHttpsAgent, maxRedirects: 0, validateStatus: () => true });
  if (resp.status !== 200) throw new Error(`SAP login failed (${resp.status}): ${JSON.stringify(resp.data)}`);
  const cookieHeader = (resp.headers['set-cookie']||[]).map(c=>c.split(';')[0]).join('; ');
  return axios.create({ baseURL: SAP.base, httpsAgent: sapHttpsAgent, headers: { Cookie: cookieHeader, 'Content-Type':'application/json' }, validateStatus:()=>true });
}

export async function sapUpdateUltimaAnaliseCredito(sap, cardCode, isoDate){
  const r = await sap.patch(`/BusinessPartners('${cardCode}')`, { U_dtUltimaAnaliseCredito: isoDate }, { headers: { 'If-Match':'*' } });
  if (r.status < 200 || r.status >= 300) throw new Error(`SAP PATCH failed (${r.status}): ${JSON.stringify(r.data)}`);
}
