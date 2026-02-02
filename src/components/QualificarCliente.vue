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

    <!-- RESULTADOS AO LADO -->
    <div class="info-panel" v-if="showInfoPanel">
      
      <div v-if="companyName" class="company-header">
        <h3 class="company-name" :title="companyName">{{ companyName }}</h3>
        <p v-if="cnpj" class="company-cnpj">CNPJ: {{ cnpj }}</p>
      </div>
      <button class="btn-copy" @click="handleCopy" :disabled="!report">
        Copiar resumo
      </button>
      <h3>Status Geral:</h3>
      <p><strong>{{ translateStatus(mainStatus) }}</strong></p>

      <div v-if="riskInfo.length">
        <h4>Detalhes de Risco:</h4>
        <ul>
          <li v-for="(risk, index) in riskInfo" :key="index"> {{ risk }}</li>
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
      <div style="margin-top:0;">
        <strong>Consulta criada em:</strong> {{ formatDateTime(dbCreatedAt) }}
      </div>
    </div>
    <transition name="fade">
      <div v-if="toast.visible" class="toast" :class="toast.kind">
        {{ toast.message }}
      </div>
    </transition>
  </div>
</template>

<script>
import { getToken, createReport, getReportById } from '@/services/gyraApi';
import { extractReportData, translateStatus, cleanDescription, formatDateTime, buildQualificacaoClipboardText } from '@/utils/reportUtils';
export default {
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
      dbCreatedAt: null,
      toast: { visible: false, message: '', kind: 'ok', _t: null },
    };
  },
  computed: {
    showInfoPanel() {
      return !this.loading && (this.mainStatus || this.riskInfo.length || this.policySummaries.length);
    }
  },
  methods: {
    translateStatus,
    cleanDescription,
    formatDateTime,
    
    _showToast(message, kind = 'ok', ms = 1800) {
      this.toast.message = message;
      this.toast.kind = kind;
      this.toast.visible = true;
      clearTimeout(this.toast._t);
      this.toast._t = setTimeout(() => (this.toast.visible = false), ms);
    },

    async _copyToClipboard(text) {
      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    },
    async handleCopy() {
      if (!this.report) return;

      // Build text exactly like your original template
      const text = buildQualificacaoClipboardText(this.report);

      const ok = await this._copyToClipboard(text);
      if (ok) this._showToast('Copiado para a área de transferência ✅', 'ok');
      else this._showToast('Não foi possível copiar. Verifique permissões.', 'error', 2600);
    },
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
          sector: 'CRDT' //CREDITO
        });
        const reportId = created.reportId || created.id;

        const fullReport = await getReportById({ token, reportId });
        this.report = fullReport;
        this.dbCreatedAt = fullReport.createdAt || this.dbCreatedAt;

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

<style scoped>
.btn-copy{
  margin: 8px 0 16px 0;
  padding: 8px 12px; border: none; border-radius: 10px;
  background: #1f7aed; color: #fff; font-weight: 600; cursor: pointer;
}
.toast{
  position: fixed; bottom: 18px; right: 18px;
  padding: 10px 14px; border-radius: 10px; font-weight: 600;
  background: #1f7aed; color: #fff; box-shadow: 0 6px 20px rgba(0,0,0,.15);
}
.toast.error{ background:#d93636 }
.fade-enter-active,.fade-leave-active{ transition: opacity .18s ease }
.fade-enter-from,.fade-leave-to{ opacity:0 }
</style>