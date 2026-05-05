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

      <div class="btn-group">
        <button class="btn-copy" @click="handleCopy" :disabled="!report">
          Copiar resumo
        </button>

        <button
          v-if="report"
          class="btn-sap"
          @click="handleAtualizarSapManual"
          :disabled="loadingSapManual || !lastReportId"
        >
          {{ loadingSapManual ? "Atualizando SAP..." : "Atualizar SAP manualmente" }}
        </button>

        <button
          class="btn-pdf"
          @click="handleGerarPdf"
          :disabled="!report || loadingPdf"
        >
          {{ loadingPdf ? "Gerando PDF..." : "⬇ Gerar PDF" }}
        </button>
      </div>

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
import { getToken, createReport, getReportById, updateReportSapManual } from '@/services/gyraApi';
import {
  extractReportData,
  translateStatus,
  cleanDescription,
  formatDateTime,
  buildQualificacaoClipboardText,
} from '@/utils/reportUtils';
import { buildOdgPayload } from '@/utils/buildOdgPayload';

export default {
  data() {
    return {
      cnpj: '',
      loading: false,
      loadingPdf: false,
      loadingSapManual: false,
      error: '',
      report: null,
      lastReportId: '',
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
    },
  },

  methods: {
    translateStatus,
    cleanDescription,
    formatDateTime,

    // ── toast ────────────────────────────────────────────────────────────────
    _showToast(message, kind = 'ok', ms = 1800) {
      this.toast.message = message;
      this.toast.kind = kind;
      this.toast.visible = true;
      clearTimeout(this.toast._t);
      this.toast._t = setTimeout(() => (this.toast.visible = false), ms);
    },

    // ── clipboard ────────────────────────────────────────────────────────────
    async _copyToClipboard(text) {
      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
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
      const text = buildQualificacaoClipboardText(this.report);
      const ok = await this._copyToClipboard(text);
      if (ok) this._showToast('Copiado para a área de transferência ✅', 'ok');
      else    this._showToast('Não foi possível copiar. Verifique permissões.', 'error', 2600);
    },

    _buildSapManualMessage(result = {}) {
      if (result.status === 'success' || result.status === 'partial') {
        return result.message || 'SAP atualizado com sucesso ✅';
      }

      switch (result.reason) {
        case 'NOT_APPROVED':
          return 'O SAP manual só pode ser atualizado quando o cliente estiver aprovado no motor.';
        case 'NO_CNPJ_IN_DB':
          return 'Não encontrei o CNPJ dessa consulta na base local para atualizar o SAP.';
        case 'BP_NOT_FOUND_FOR_CNPJ':
          return 'Não encontrei este cliente no SAP a partir do CNPJ da última consulta.';
        case 'SAP_UPDATE_ERROR':
          return result.message || 'Ocorreu um erro ao atualizar o SAP manualmente.';
        case 'SAP_CODES_UPDATE_FAILED':
          return result.message || 'Nao foi possivel atualizar os codigos relacionados no SAP.';
        default:
          return result.message || 'Não foi possível atualizar o SAP com os dados da última consulta.';
      }
    },

    async handleAtualizarSapManual() {
      if (!this.lastReportId) return;

      this.loadingSapManual = true;
      try {
        const result = await updateReportSapManual({ reportId: this.lastReportId });
        const message = this._buildSapManualMessage(result);
        const kind = result.status === 'success' || result.status === 'partial' ? 'ok' : 'error';
        this._showToast(message, kind, 3200);
      } catch (err) {
        console.error('❌ QualificarCliente.handleAtualizarSapManual:', err);
        this._showToast(
          err.response?.data?.message || err.response?.data?.error || err.message || 'Erro ao atualizar o SAP manualmente.',
          'error',
          3500
        );
      } finally {
        this.loadingSapManual = false;
      }
    },

    // ── gerar PDF ────────────────────────────────────────────────────────────
    async handleGerarPdf() {
      if (!this.report) return;

      this.loadingPdf = true;
      try {
        // Monta o payload com os dados do relatório mapeados para os campos do ODG
        const dados = buildOdgPayload(this.report);

        // Chama o endpoint do seu backend que executa o preencher_odg.js
        // O backend deve receber { dados } e devolver o PDF como blob
        const response = await fetch('/api/gerar-pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dados }),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.message || `Erro ${response.status} ao gerar PDF`);
        }

        // Faz o download automático do PDF no navegador
        const blob = await response.blob();
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        const nomeArquivo = `relatorio_${(this.companyName || this.cnpj).replace(/\s+/g, '_')}.pdf`;
        a.href     = url;
        a.download = nomeArquivo;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        this._showToast('PDF gerado com sucesso ✅', 'ok', 2500);
      } catch (err) {
        console.error('❌ handleGerarPdf:', err);
        this._showToast(`Erro ao gerar PDF: ${err.message}`, 'error', 3500);
      } finally {
        this.loadingPdf = false;
      }
    },

    // ── consulta CNPJ ────────────────────────────────────────────────────────
    async handleCNPJSearch() {
      this.loading = true;
      this.error   = '';
      this.report  = null;
      this.lastReportId = '';
      this.companyName = '';

      try {
        const token = await getToken();

        const created = await createReport({
          token,
          cnpj: this.cnpj,
          policyId: process.env.VUE_APP_GYRA_POLICY_ID,
          sector: 'CRDT',
        });
        const reportId = created.reportId || created.id;
        this.lastReportId = reportId;

        const fullReport = await getReportById({ token, reportId });
        this.report      = fullReport;
        this.lastReportId = fullReport?.id || reportId;
        this.dbCreatedAt = fullReport.createdAt || this.dbCreatedAt;

        const { companyName, mainStatus, riskInfo, policySummaries } = extractReportData(fullReport);
        this.companyName    = companyName;
        this.mainStatus     = mainStatus;
        this.riskInfo       = riskInfo;
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
.btn-group {
  display: flex;
  gap: 8px;
  margin: 8px 0 16px 0;
  flex-wrap: wrap;
}

.btn-copy,
.btn-sap,
.btn-pdf {
  padding: 8px 12px;
  border: none;
  border-radius: 10px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.btn-copy {
  background: #1f7aed;
  color: #fff;
}

.btn-pdf {
  background: #16a34a;
  color: #fff;
}

.btn-sap {
  background: #d97706;
  color: #fff;
}

.btn-copy:disabled,
.btn-sap:disabled,
.btn-pdf:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.toast {
  position: fixed;
  bottom: 18px;
  right: 18px;
  padding: 10px 14px;
  border-radius: 10px;
  font-weight: 600;
  background: #1f7aed;
  color: #fff;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
}
.toast.error { background: #d93636; }

.fade-enter-active,
.fade-leave-active { transition: opacity 0.18s ease; }
.fade-enter-from,
.fade-leave-to { opacity: 0; }
</style>
