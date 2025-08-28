// src/services/gyraApi.js
import axios from 'axios';

const BASE =  'http://192.168.87.87:3001';

export async function getToken() {
  const { data } = await axios.post(`${BASE}/api/token`);
  return data.token;
}

export async function createReport({ token, cnpj, policyId, sector }) {
  const { data } = await axios.post(`${BASE}/api/report`, { token, cnpj, policyId, sector });
  // returns { reused, reportId } or { id }
  return data;
}

export async function getReportById({ token, reportId }) {
  const { data } = await axios.get(`${BASE}/api/report/${reportId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return data;
}
