<template>
  <div class="duplo-layout">
    <!-- FORMULÁRIO PRINCIPAL -->
    <div class="home-container">
      <h2>Consulta de Cliente</h2>

      <form @submit.prevent="handleCNPJSearch">
        <input v-model="cnpj" id="cnpj" placeholder="Digite o CNPJ" required />

        <button type="submit" :disabled="loading">
          {{ loading ? "Consultando..." : "Consultar" }}
        </button>
      </form>

      <div class="consulta-info with-icon">
        <img src="@/assets/Verify-icon.png" alt="Verificado" class="icon-verificado" />
        <span>
          Os resultados das consultas são baseados nas políticas de crédito da GP e nos dados dos principais bureaus de crédito e inteligência artificial do mercado.
        </span>
      </div>

      <div v-if="error" class="error">{{ error }}</div>
    </div>


    <div class="info-panel" v-if="mainStatus || riskInfo.length || policySummaries.length">
      
      <div v-if="companyName" class="company-header">
        <h3 class="company-name" :title="companyName">{{ companyName }}</h3>
        <p v-if="cnpj" class="company-cnpj">CNPJ: {{ cnpj }}</p>
      </div>
      <h3>Status Geral:</h3>
      <p><strong>{{ translateStatus(mainStatus) }}</strong></p>

      <div v-if="riskInfo.length">
        <h4>Detalhes de Risco:</h4>
        <ul>
          <li v-for="(risk, index) in riskInfo" :key="index"> {{ risk }}</li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script>
import { getToken, createReport, getReportById } from '@/services/gyraApi';
import { extractReportData, translateStatus, cleanDescription } from '@/utils/reportUtils';

export default {
  name: 'ComercialPage',
  data() {
    return {
      cnpj: '',
      loading: false,
      error: '',
      report: null,
      companyName: '',
      mainStatus: '',
      riskInfo: [],
      policySummaries: [],
    };
  },
  methods: {
    translateStatus,
    cleanDescription,

    async handleCNPJSearch() {
      this.loading = true;
      this.error = '';
      this.report = null;
      this.companyName = '';

      try {
        const token = await getToken();

        const created = await createReport({
          token,
          cnpj: this.cnpj,
          policyId: process.env.VUE_APP_GYRA_POLICY_ID,
          sector: 'CMRC', 
        });
        const reportId = created.reportId || created.id;

        const fullReport = await getReportById({ token, reportId });
        this.report = fullReport;

        const { companyName, mainStatus, riskInfo, policySummaries } = extractReportData(fullReport);
        this.companyName = companyName;
        this.mainStatus = mainStatus;
        this.riskInfo = riskInfo;
        this.policySummaries = policySummaries;
      } catch (err) {
        console.error('❌ Marketing.handleCNPJSearch:', err);
        this.error = err.response?.data?.error || err.message;
      } finally {
        this.loading = false;
      }
    },
  },
};
</script>

<style src="@/assets/styles/credito.css"></style>
