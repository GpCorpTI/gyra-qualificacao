<template>
  <div class="duplo-layout">
    <!-- LEFT: list + toolbar -->
    <div class="home-container list-panel">
      <div class="header-row">
        <h2>Relatórios (últimos 90 dias)</h2>
        <a
          class="export-btn"
          :href="exportUrl"
          target="_blank"
          rel="noopener"
          title="Exportar lista como Excel"
        >
          Exportar Excel
        </a>
      </div>

      <div v-if="loadingList" class="loading">Carregando lista…</div>
      <div v-else-if="!reports.length" class="empty">Nenhum relatório encontrado.</div>

      <ul class="report-list" v-else>
        <li
          v-for="row in reports"
          :key="row.id"
          :class="['report-item', { selected: row.report_id === selectedReportId }]"
        >
          <button
            class="report-btn"
            @click="onSelectReport(row)"
            :disabled="loadingReport && row.report_id === selectedReportId"
            :aria-busy="loadingReport && row.report_id === selectedReportId"
          >
            <div class="title">{{ row.business_name || 'Sem nome' }}</div>
            <div class="meta">
              <span>{{ row.cnpj }}</span>
              <span> • {{ formatDateTime(row.created_at) }}</span>
              <span v-if="row.sector"> • {{ row.sector }}</span>
            </div>
          </button>
        </li>
      </ul>
    </div>

    <!-- RIGHT: details -->
    <div
      class="info-panel"
      v-if="companyName || mainStatus || riskInfo.length || policySummaries.length || loadingReport || error"
    >
      <h3 v-if="companyName" class="company-name" :title="companyName">{{ companyName }}</h3>
      <p v-if="cnpjFromSelected" class="company-cnpj">CNPJ: {{ cnpjFromSelected }}</p>

      <div v-if="loadingReport" class="loading">🔄 Buscando relatório… aguarde.</div>
      <div v-if="error" class="error">{{ error }}</div>

      <template v-if="!loadingReport && !error && (mainStatus || riskInfo.length || policySummaries.length)">
        <h3>Status Geral:</h3>
        <p><strong>{{ translateStatus(mainStatus) }}</strong></p>

        <div v-if="riskInfo.length">
          <h4>Detalhes de Risco:</h4>
          <ul>
            <li v-for="(risk, index) in riskInfo" :key="index">{{ risk }}</li>
          </ul>
        </div>

        <div v-if="policySummaries.length">
          <h4>Regras da Política:</h4>
          <ul>
            <li v-for="(rule, index) in policySummaries" :key="index">
              <strong>{{ cleanDescription(rule.description) }}</strong> — <em>{{ rule.status }}</em>
            </li>
          </ul>
        </div>
      </template>

      <div v-if="cooldownRemaining > 0" class="cooldown">
        Aguarde {{ cooldownRemaining }}s para nova consulta deste relatório.
      </div>
    </div>
  </div>
</template>

<script>
import { getToken, listReports, getReportById } from '@/services/gyraApi';
import { extractReportData, translateStatus, cleanDescription } from '@/utils/reportUtils';

const BASE = process.env.VUE_APP_BACKEND_URL || 'http://192.168.87.87:3001';

export default {
  name: 'ListarReport',
  data() {
    return {
      reports: [],
      selectedReportId: null,
      selectedRow: null,

      loadingList: false,
      loadingReport: false,
      error: '',

      // detail panel
      report: null,
      companyName: '',
      mainStatus: '',
      riskInfo: [],
      policySummaries: [],

      // cooldown
      cooldownRemaining: 0,

      // token cache
      token: null,
    };
  },
  computed: {
    exportUrl() {
      return `${BASE}/api/reports.xlsx`;
    },
    cnpjFromSelected() {
      return this.selectedRow?.cnpj || '';
    },
  },
  created() {
    this.init();
  },
  methods: {
    translateStatus,
    cleanDescription,

    async init() {
      try {
        this.loadingList = true;
        // this.token = await getToken();
        this.reports = await listReports();
      } catch (err) {
        console.error('❌ init/listReports:', err);
        this.error = err.response?.data?.error || err.message;
      } finally {
        this.loadingList = false;
      }
    },

    // 60s client-side cooldown per reportId
    ensureCooldown(key, ms = 30_000) {
      const map = JSON.parse(localStorage.getItem('reportCooldown') || '{}');
      const now = Date.now();
      const last = map[key] || 0;
      const remaining = last + ms - now;
      if (remaining > 0) {
        this.cooldownRemaining = Math.ceil(remaining / 1000);
        throw new Error(`Aguarde ${this.cooldownRemaining}s para consultar este relatório novamente.`);
      }
      map[key] = now;
      localStorage.setItem('reportCooldown', JSON.stringify(map));
      this.cooldownRemaining = 0;
    },

    async onSelectReport(row) {
      const reportId = row.report_id;
      this.selectedReportId = reportId;
      this.selectedRow = row;

      // reset detail panel
      this.error = '';
      this.loadingReport = true;
      this.report = null;
      this.companyName = '';
      this.mainStatus = '';
      this.riskInfo = [];
      this.policySummaries = [];

      try {
        this.ensureCooldown(reportId);
        if (!this.token) this.token = await getToken();

        const fullReport = await getReportById({ token: this.token, reportId });
        this.report = fullReport;

        const { companyName, mainStatus, riskInfo, policySummaries } = extractReportData(fullReport);
        this.companyName = companyName;
        this.mainStatus = mainStatus;
        this.riskInfo = riskInfo;
        this.policySummaries = policySummaries;
      } catch (err) {
        console.error('❌ onSelectReport:', err);
        this.error = err.message || 'Falha ao carregar relatório.';
      } finally {
        this.loadingReport = false;
      }
    },

    formatDateTime(isoOrSql) {
      try {
        const d = new Date(isoOrSql);
        return d.toLocaleString('pt-BR');
      } catch {
        return isoOrSql;
      }
    },
  },
};
</script>

<style scoped>
/* minimal local styles; relies on your global .home-container/.info-panel/.duplo-layout */
.list-panel {
  width: 40%;
  min-width: 320px;
}

.info-panel { 
  width: 40%; 
  min-width: 200px; 
  top: 16px; 
  position: sticky; 
  align-self: flex-start; 
}

/* header row with export button */
.header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.home-container.list-panel h2,
.header-row h2 {
  font-size: 30px !important; /* override global 45px */
  line-height: 1.2;
  margin: 0;
}

.export-btn {
  display: inline-block;
  padding: 8px 12px;
  font-size: 14px;
  text-decoration: none;
  border-radius: 8px;
  background: #1b263b;
  color: #ffffff;
  border: 1px solid rgba(142,202,230,0.3);
  transition: background-color .2s ease, border-color .2s ease;
}
.export-btn:hover {
  background: #24344d;
  border-color: #8ecae6;
}

.report-list {
  list-style: none;
  padding: 0;
  margin: 12px 0 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.report-item .report-btn {
  width: 100%;
  text-align: left;
  background: #1b263b;
  color: #fff;
  border: 1px solid transparent;
  border-radius: 10px;
  padding: 12px 14px;
  cursor: pointer;
  transition: background-color .2s ease, border-color .2s ease;
}

.report-item .report-btn:hover {
  background: #24344d;
}

.report-item.selected .report-btn {
  border-color: #8ecae6;
  box-shadow: 0 0 0 2px rgba(142,202,230,.15);
}

.report-btn .title {
  font-weight: 600;
  margin-bottom: 4px;
  color: #ffffff;
}

.report-btn .meta {
  font-size: 13px;
  color: #8ecae6;
}

.loading { color: #8ecae6; }
.empty { color: #8ecae6; opacity: .8; }
.error { color: #ff6b6b; margin-top: 8px; }
.cooldown { margin-top: 10px; color: #ffd166; }
.company-name { color: #fff; margin-bottom: 2px; }
.company-cnpj { color: #8ecae6; margin-top: 0; }
</style>
