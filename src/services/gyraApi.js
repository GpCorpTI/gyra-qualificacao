// src/services/gyraApi.js
import axios from 'axios';

const api = axios.create({
  baseURL: '/api', // same-origin, works with any host/port
});

// calls:
export async function getToken() {
  const { data } = await api.post('/token');
  return data.token;
}
export async function createReport({ token, cnpj, policyId, sector }) {
  const { data } = await api.post('/report', { token, cnpj, policyId, sector });
  return data;
}
export async function getReportById({ token, reportId }) {
  const { data } = await api.get(`/report/${reportId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return data;
}
export async function listReports() {
  const { data } = await api.get('/reports');
  return data;
}
