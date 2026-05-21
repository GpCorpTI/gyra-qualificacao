// src/services/gyraApi.js
import axios from 'axios';

const api = axios.create({
  baseURL: '/api', // same-origin, works with any host/port
  timeout: 120000,
});

function normalizeApiError(error) {
  if (error.code === 'ECONNABORTED') {
    return new Error('A consulta demorou mais que o esperado. Tente novamente em instantes.');
  }

  if (!error.response) {
    return new Error('Nao consegui concluir a conexao com o backend do MARCI. Verifique a rede ou tente novamente.');
  }

  return error;
}

api.interceptors.response.use(
  response => response,
  error => Promise.reject(normalizeApiError(error))
);

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

export async function updateReportSapManual({ reportId }) {
  const { data } = await api.post(`/report/${reportId}/update-sap-manual`);
  return data;
}

export async function listReports() {
  const { data } = await api.get('/reports');
  return data;
}

export async function getMarciGyraSummary({ cnpj, policyId }) {
  const { data } = await api.post('/marci/gyra-summary', { cnpj, policyId });
  return data;
}

export async function sendMarciMessage({ message, history = [], policyId }) {
  const { data } = await api.post('/marci/chat', { message, history, policyId });
  return data;
}

export async function checkOrderRelease({ cnpj }) {
  const { data } = await api.post('/order-release', { cnpj });
  return data;
}

export async function updateOrderReleaseCrm({ cnpj }) {
  const { data } = await api.post('/order-release/update-crm', { cnpj });
  return data;
}

export async function searchPartnerDocsByCpf({ cpf }) {
  const { data } = await api.post('/partner-docs/search', { cpf });
  return data;
}
