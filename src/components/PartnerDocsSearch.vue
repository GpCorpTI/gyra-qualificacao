<template>
  <div class="partner-page">
    <section class="search-card">
      <div class="header-copy">
        <p class="eyebrow">SAP Business One</p>
        <h1>Vínculos por CPF</h1>
        <p>
          Pesquise um CPF de sócio para localizar clientes SAP cujo campo
          <strong>U_partnerdocs</strong> contenha esse documento.
        </p>
      </div>

      <form class="search-form" @submit.prevent="handleSearch">
        <input
          v-model="cpf"
          type="text"
          placeholder="Digite o CPF"
          inputmode="numeric"
          autocomplete="off"
          @input="formatCpfInput"
        />
        <button type="submit" :disabled="loading">
          {{ loading ? 'Pesquisando...' : 'Pesquisar vínculos' }}
        </button>
      </form>

      <p v-if="error" class="error">{{ error }}</p>
    </section>

    <section v-if="searched" class="results-card">
      <div class="results-header">
        <div>
          <p class="eyebrow">Resultado</p>
          <h2>{{ resultTitle }}</h2>
        </div>
        <span class="count-pill">{{ results.length }} vínculo(s)</span>
      </div>

      <div v-if="!results.length && !loading" class="empty-state">
        Nenhum cliente encontrado com esse CPF em U_partnerdocs.
      </div>

      <div v-else class="result-list">
        <article v-for="item in results" :key="`${item.cardCode}-${item.cnpj}`" class="result-item">
          <div>
            <span class="card-code">{{ item.cardCode }}</span>
            <h3>{{ item.name || 'Sem nome' }}</h3>
            <p v-if="item.fantasyName">Fantasia: {{ item.fantasyName }}</p>
          </div>
          <div class="result-meta">
            <span>CNPJ: {{ item.cnpj || 'N/D' }}</span>
            <small>U_partnerdocs: {{ item.partnerDocs || 'N/D' }}</small>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>

<script>
import { searchPartnerDocsByCpf } from '@/services/gyraApi';

function onlyDigits(value = '') {
  return String(value).replace(/\D/g, '');
}

function formatCPF(value = '') {
  const digits = onlyDigits(value).slice(0, 11);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)}.${digits.slice(3)}`;
  if (digits.length <= 9) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

export default {
  name: 'PartnerDocsSearch',
  data() {
    return {
      cpf: '',
      searchedCpf: '',
      results: [],
      loading: false,
      searched: false,
      error: '',
    };
  },
  computed: {
    resultTitle() {
      return this.searchedCpf ? `CPF ${this.searchedCpf}` : 'Consulta por CPF';
    },
  },
  methods: {
    formatCpfInput() {
      this.cpf = formatCPF(this.cpf);
    },
    async handleSearch() {
      const normalized = onlyDigits(this.cpf);

      if (normalized.length !== 11 || /^(\d)\1{10}$/.test(normalized)) {
        this.error = 'Informe um CPF válido para pesquisar.';
        return;
      }

      this.loading = true;
      this.error = '';
      this.searched = false;

      try {
        const data = await searchPartnerDocsByCpf({ cpf: normalized });
        this.results = data.results || [];
        this.searchedCpf = data.cpf || formatCPF(normalized);
        this.searched = true;
      } catch (err) {
        this.results = [];
        this.error = err.response?.data?.error || err.message || 'Falha ao consultar vínculos no SAP.';
      } finally {
        this.loading = false;
      }
    },
  },
};
</script>

<style scoped>
.partner-page {
  width: min(1120px, calc(100% - 32px));
  margin: 0 auto;
  padding: 28px 0 48px;
}

.search-card,
.results-card {
  border: 1px solid rgba(142, 202, 230, 0.18);
  border-radius: 22px;
  background:
    linear-gradient(135deg, rgba(13, 27, 42, 0.95), rgba(27, 38, 59, 0.92)),
    radial-gradient(circle at top right, rgba(142, 202, 230, 0.16), transparent 36%);
  box-shadow: 0 20px 54px rgba(0, 0, 0, 0.3);
  color: #fff;
}

.search-card {
  padding: 34px;
}

.header-copy {
  max-width: 780px;
}

.eyebrow {
  margin: 0 0 8px;
  color: #8ecae6;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

h1,
h2,
h3,
p {
  margin-top: 0;
}

h1 {
  margin-bottom: 10px;
  font-size: clamp(34px, 5vw, 52px);
  line-height: 1;
}

.header-copy p {
  color: rgba(255, 255, 255, 0.78);
  line-height: 1.55;
}

.search-form {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto;
  gap: 12px;
  margin-top: 26px;
}

input,
button {
  border: 0;
  border-radius: 14px;
  font: inherit;
}

input {
  padding: 16px 18px;
  color: #0d1b2a;
  background: rgba(255, 255, 255, 0.94);
  outline: none;
}

button {
  padding: 0 22px;
  color: #061522;
  font-weight: 800;
  background: #8ecae6;
  cursor: pointer;
  transition: transform 0.2s ease, background 0.2s ease;
}

button:hover:not(:disabled) {
  background: #b7e4f5;
  transform: translateY(-1px);
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.65;
}

.error {
  margin: 16px 0 0;
  color: #ffb4a2;
  font-weight: 700;
}

.results-card {
  margin-top: 22px;
  padding: 26px;
}

.results-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.results-header h2 {
  margin-bottom: 0;
}

.count-pill,
.card-code {
  display: inline-flex;
  width: fit-content;
  border-radius: 999px;
  font-weight: 800;
}

.count-pill {
  padding: 8px 12px;
  color: #0d1b2a;
  background: #ffd166;
}

.result-list {
  display: grid;
  gap: 12px;
}

.result-item {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(240px, 0.8fr);
  gap: 18px;
  padding: 18px;
  border: 1px solid rgba(255, 255, 255, 0.11);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.07);
}

.card-code {
  margin-bottom: 10px;
  padding: 5px 9px;
  color: #061522;
  background: #8ecae6;
  font-size: 13px;
}

.result-item h3 {
  margin-bottom: 6px;
  font-size: 20px;
}

.result-item p,
.result-meta {
  color: rgba(255, 255, 255, 0.76);
}

.result-meta {
  display: grid;
  gap: 8px;
  align-content: center;
  text-align: right;
}

.result-meta small {
  color: rgba(255, 255, 255, 0.58);
  word-break: break-word;
}

.empty-state {
  padding: 24px;
  border-radius: 16px;
  color: rgba(255, 255, 255, 0.74);
  background: rgba(255, 255, 255, 0.07);
}

@media (max-width: 760px) {
  .search-form,
  .result-item {
    grid-template-columns: 1fr;
  }

  button {
    min-height: 52px;
  }

  .results-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .result-meta {
    text-align: left;
  }
}
</style>
