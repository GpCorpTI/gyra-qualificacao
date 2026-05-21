<template>
  <div class="duplo-layout">
    <div class="home-container">
      <h2>Liberação de Pedido</h2>

      <form @submit.prevent="handleSubmit">
        <input v-model="cnpj" id="cnpj" placeholder="Digite o CNPJ" required />

        <button type="submit" :disabled="loading">
          {{ loading ? 'Verificando...' : 'Verificar liberação' }}
        </button>
      </form>

      <div class="consulta-info with-icon">
        <img src="@/assets/Verify-icon.png" alt="Verificado" class="icon-verificado" />
        <span>
          Consulta dedicada para verificar aprovação pela política de liberação de pedido e atualizar o CRM B1.
        </span>
      </div>

      <div v-if="error" class="error">{{ error }}</div>
    </div>

    <div v-if="result" class="info-panel">
      <div class="company-header">
        <h3 class="company-name" :title="result.companyName">{{ result.companyName }}</h3>
        <p class="company-cnpj">CNPJ: {{ result.cnpj }}</p>
        <p v-if="result.cardCode" class="company-cnpj">CardCode: {{ result.cardCode }}</p>
      </div>

      <h3>Status da Liberação:</h3>
      <p>
        <strong :class="statusClass">{{ statusLabel }}</strong>
      </p>

      <div class="btn-group">
        <button
          v-if="showActionButton"
          class="btn-release"
          :class="{ 'btn-release--pending': result?.pending, 'btn-release--denied': result && !result.pending && !result.approved }"
          @click="handleActionButton"
          :disabled="actionButtonDisabled"
        >
          {{ actionButtonLabel }}
        </button>

        <button class="btn-copy" @click="handleCopyRelease" :disabled="!result">
          Copiar liberação
        </button>
      </div>

      <div class="release-summary">
        <p><strong>Status Gyra:</strong> {{ result.statusValue || 'Sem status' }}</p>
        <p><strong>Relatório:</strong> {{ result.reportId }}</p>
        <p><strong>Consulta:</strong> {{ result.reused ? 'Reaproveitada dentro de 45 dias' : 'Novo relatório criado' }}</p>
        <p><strong>CRM B1:</strong> {{ crmStatusLabel }}</p>
      </div>

      <div v-if="showRejectedReasons" class="reason-box">
        <h4>Motivo da não liberação</h4>
        <p>{{ result.releaseReasonSummary || 'Não foram retornados motivos detalhados pela política.' }}</p>
      </div>
    </div>
  </div>
</template>

<script>
import { checkOrderRelease, updateOrderReleaseCrm } from '@/services/gyraApi';

export default {
  name: 'LiberacaoPedido',
  data() {
    return {
      cnpj: '',
      loading: false,
      loadingCrm: false,
      error: '',
      result: null,
    };
  },
  computed: {
    statusLabel() {
      if (!this.result) return '';
      if (this.result.pending) return 'Relatório em processamento';
      return this.result.approved ? 'Pedido liberado' : 'Pedido não liberado';
    },
    statusClass() {
      if (!this.result) return '';
      if (this.result.pending) return 'status-pending';
      return this.result.approved ? 'status-approved' : 'status-denied';
    },
    crmStatusLabel() {
      const status = this.result?.crmWebhook?.status;
      const reason = this.result?.crmWebhook?.reason;

      if (status === 'success') return 'Atualizado com sucesso';
      if (status === 'failed') return 'Falha ao atualizar CRM';
      if (status === 'skipped' && reason === 'GYRA_PENDING') return 'Aguardando conclusão do Gyra';
      if (status === 'skipped' && reason === 'CARD_CODE_NOT_FOUND') return 'CardCode não encontrado';
      if (status === 'skipped' && reason === 'WAITING_USER_ACTION') return 'Aguardando ação do usuário';
      if (status === 'skipped') return 'Não acionado';
      return 'Não informado';
    },
    showRejectedReasons() {
      return this.result && !this.result.pending && !this.result.approved;
    },
    showActionButton() {
      return !!this.result;
    },
    actionButtonDisabled() {
      return this.loading || this.loadingCrm || this.result?.crmWebhook?.status === 'success';
    },
    actionButtonLabel() {
      if (this.loadingCrm) return 'Atualizando CRM B1...';
      if (this.result?.crmWebhook?.status === 'success' && this.result?.pending) return 'Pendência enviada ao CRM B1';
      if (this.result?.crmWebhook?.status === 'success' && !this.result?.approved) return 'Não liberação enviada ao CRM B1';
      if (this.result?.crmWebhook?.status === 'success') return 'Pedido liberado no CRM B1';
      if (this.result?.crmWebhook?.status === 'failed') return 'Tentar liberar novamente';
      if (this.result?.pending) return 'Enviar pendência ao CRM B1';
      if (!this.result?.approved) return 'Enviar não liberação ao CRM B1';
      return 'Liberar pedido no CRM B1';
    },
  },
  methods: {
    async handleSubmit() {
      const outgoing = String(this.cnpj || '').trim();
      if (!outgoing || this.loading) return;

      this.loading = true;
      this.error = '';
      this.result = null;

      try {
        this.result = await checkOrderRelease({ cnpj: outgoing });
      } catch (err) {
        this.error = err.response?.data?.error || err.message || 'Erro ao verificar liberação do pedido.';
      } finally {
        this.loading = false;
      }
    },
    async handleActionButton() {
      const outgoing = String(this.result?.cnpj || this.cnpj || '').trim();
      if (!outgoing || this.loading || this.loadingCrm) return;

      this.loadingCrm = true;
      this.error = '';

      try {
        this.result = await updateOrderReleaseCrm({ cnpj: outgoing });
      } catch (err) {
        this.error = err.response?.data?.error || err.message || 'Erro ao atualizar liberação no CRM B1.';
      } finally {
        this.loadingCrm = false;
      }
    },
    buildReleaseCopyText() {
      if (!this.result) return '';

      return [
        'Liberação de Pedido',
        `Cliente: ${this.result.companyName || 'N/D'}`,
        `CNPJ: ${this.result.cnpj || 'N/D'}`,
        `CardCode: ${this.result.cardCode || 'N/D'}`,
        `Status: ${this.statusLabel}`,
        `Status Gyra: ${this.result.statusValue || 'Sem status'}`,
        `Relatório: ${this.result.reportId || 'N/D'}`,
        `Consulta: ${this.result.reused ? 'Reaproveitada dentro de 45 dias' : 'Novo relatório criado'}`,
        `CRM B1: ${this.crmStatusLabel}`,
        this.showRejectedReasons
          ? `Motivo da não liberação: ${this.result.releaseReasonSummary || 'Não informado'}`
          : '',
      ].filter(Boolean).join('\n');
    },
    async handleCopyRelease() {
      const text = this.buildReleaseCopyText();
      if (!text) return;

      try {
        await navigator.clipboard.writeText(text);
        alert('Resumo de liberação copiado!');
      } catch (err) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        alert('Resumo de liberação copiado!');
      }
    },
  },
};
</script>

<style src="@/assets/styles/credito.css"></style>

<style scoped>
.release-summary {
  display: grid;
  gap: 8px;
  margin-top: 12px;
  color: white;
}

.release-summary p {
  margin: 0;
}

.btn-group {
  display: flex;
  justify-content: center;
  margin: 14px 0;
}

.btn-copy,
.btn-release {
  border: none;
  border-radius: 6px;
  padding: 10px 14px;
  color: white;
  cursor: pointer;
}

.btn-copy {
  background: #264653;
}

.btn-release {
  background: #1f8f4d;
  box-shadow: 0 0 0 1px rgba(112, 224, 0, 0.2);
}

.btn-release:not(:disabled):hover {
  background: #25a85b;
}

.btn-release--pending {
  background: #b98512;
  box-shadow: 0 0 0 1px rgba(255, 209, 102, 0.24);
}

.btn-release--pending:not(:disabled):hover {
  background: #d49a16;
}

.btn-release--denied {
  background: #9b2f3a;
  box-shadow: 0 0 0 1px rgba(255, 123, 123, 0.24);
}

.btn-release--denied:not(:disabled):hover {
  background: #b83a47;
}

.btn-copy:disabled,
.btn-release:disabled {
  cursor: not-allowed;
  opacity: 0.65;
}

.reason-box {
  margin-top: 16px;
  padding: 14px;
  border: 1px solid rgba(255, 123, 123, 0.36);
  border-radius: 8px;
  color: white;
  background: rgba(255, 123, 123, 0.09);
}

.reason-box h4 {
  margin: 0 0 8px;
  color: #ffb3b3;
}

.reason-box p {
  margin: 0;
  line-height: 1.45;
}

.status-approved {
  color: #70e000;
}

.status-denied {
  color: #ff7b7b;
}

.status-pending {
  color: #ffd166;
}
</style>
