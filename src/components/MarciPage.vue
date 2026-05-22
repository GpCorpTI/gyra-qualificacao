<template>
  <div class="center-layout">
    <div class="marci-shell">
      <div class="marci-panel">
        <div class="marci-layout">
          <aside class="overview-shell">
            <p class="eyebrow">Assistente restrito</p>

            <div class="headline-row">
              <span class="status-pill">MARCI Core</span>
            </div>

            <h1>MARCI</h1>

            <p class="tagline">Assistente Inteligente de decisão de Crédito</p>
          </aside>

          <section class="chat-shell">
            <div class="chat-header">
              <div>
                <h2>Fale com o MARCI</h2>
              </div>
            </div>

            <div ref="messageList" class="message-list">
              <article
                v-for="message in messages"
                :key="message.id"
                :class="['message-item', `message-${message.role}`]"
              >
                <div class="message-bubble">
                  <div v-if="message.role === 'assistant'" class="message-actions">
                    <button
                      type="button"
                      class="copy-button"
                      @click="copyAssistantMessage(message)"
                    >
                      {{ copyButtonLabel(message.id) }}
                    </button>
                  </div>

                  <span class="message-role">
                    {{ message.role === 'assistant' ? 'MARCI' : 'Voce' }}
                  </span>

                  <p class="message-text">{{ message.text }}</p>

                  <div v-if="message.sources?.length" class="source-row">
                    <span
                      v-for="source in message.sources"
                      :key="source"
                      class="source-chip"
                    >
                      {{ source }}
                    </span>
                  </div>

                  <div v-if="message.cards?.length" class="card-grid">
                    <div
                      v-for="card in message.cards"
                      :key="`${message.id}-${card.title}`"
                      class="card-item"
                      :class="getCardClasses(card)"
                    >
                      <div class="card-heading">
                        <span class="card-label">{{ card.title }}</span>
                        <span v-if="card.category" class="card-category">{{ card.category }}</span>
                      </div>
                      <div
                        v-if="card.table?.rows?.length"
                        class="card-table"
                        :class="`card-table-${card.table.variant || 'default'}`"
                      >
                        <div class="card-table-header">
                          <span
                            v-for="column in card.table.columns"
                            :key="`${message.id}-${card.title}-${column.key}`"
                            class="card-table-head-cell"
                          >
                            {{ column.label }}
                          </span>
                        </div>
                        <div
                          v-for="row in card.table.rows"
                          :key="`${message.id}-${card.title}-${row.id}`"
                          class="card-table-row"
                        >
                          <span
                            v-for="column in card.table.columns"
                            :key="`${message.id}-${card.title}-${row.id}-${column.key}`"
                            class="card-table-cell"
                          >
                            <span
                              v-if="column.key === 'statusLabel'"
                              class="card-status-badge"
                              :class="`card-status-${row.statusTone || 'neutral'}`"
                            >
                              {{ row[column.key] }}
                            </span>
                            <template v-else>
                              {{ row[column.key] }}
                            </template>
                          </span>
                        </div>
                      </div>
                      <div v-else-if="card.items?.length" class="card-inline-list">
                        <span
                          v-for="item in card.items"
                          :key="`${message.id}-${card.title}-${item.name}-${item.document}`"
                          class="card-inline-item"
                        >
                          <strong class="card-inline-name">{{ item.name }}</strong>
                          <span v-if="item.document" class="card-inline-document"> - {{ item.document }}</span>
                        </span>
                      </div>
                      <strong v-else class="card-value">{{ card.value }}</strong>
                      <p v-if="card.note" class="card-note">{{ card.note }}</p>
                    </div>
                  </div>

                  <div v-if="message.metadata && hasMetadata(message.metadata)" class="message-meta">
                    <span v-if="message.metadata.cnpj">CNPJ: {{ message.metadata.cnpj }}</span>
                    <span v-if="message.metadata.cardCode">CardCode: {{ message.metadata.cardCode }}</span>
                    <span v-if="message.metadata.reportId">Relatorio: {{ message.metadata.reportId }}</span>
                    <span v-if="message.metadata.createdAt">Base: {{ formatDateTime(message.metadata.createdAt) }}</span>
                  </div>

                </div>
              </article>

              <article v-if="loading" class="message-item message-assistant">
                <div class="message-bubble loading-bubble">
                  <span class="message-role">MARCI</span>
                  <p class="message-text">Analisando a mensagem e roteando a consulta permitida.</p>
                </div>
              </article>
            </div>

            <form class="composer" @submit.prevent="handleSubmit()">
              <textarea
                ref="composerInput"
                v-model="draft"
                rows="3"
                placeholder="Ex.: Consulte o CNPJ 12.345.678/0001-99 no Gyra"
                :disabled="loading"
                @keydown.enter.exact.prevent="handleSubmit()"
              />

              <div class="composer-footer">
                <p class="composer-hint">
                  Use uma pergunta curta com CNPJ para iniciar.
                </p>

                <button type="submit" class="send-button" :disabled="loading || !draft.trim()">
                  {{ loading ? 'Consultando...' : 'Enviar ao MARCI' }}
                </button>
              </div>
            </form>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { sendMarciMessage } from '@/services/gyraApi';

function createId(prefix = 'msg') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatCopyValue(value) {
  if (value === null || value === undefined || value === '') return '';
  return String(value);
}

function normalizeCardToken(value) {
  return String(value || 'default')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'default';
}

async function writeTextToClipboard(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);

  if (!copied) {
    throw new Error('Clipboard copy failed');
  }
}

export default {
  name: 'MarciPage',
  data() {
    return {
      draft: '',
      loading: false,
      copiedMessageId: '',
      copyFailedMessageId: '',
      messages: [
        {
          id: createId('assistant'),
          role: 'assistant',
          text: 'Ola, eu sou o MARCI. Envie um CNPJ para eu combinar as informacoes disponiveis de GYRA+ e SAP em uma leitura de credito.',
          sources: [],
          cards: [],
          suggestions: [],
          metadata: {},
        },
      ],
    };
  },
  methods: {
    hasMetadata(metadata) {
      return Boolean(
        metadata &&
        (metadata.cnpj || metadata.cardCode || metadata.reportId || metadata.createdAt)
      );
    },
    formatDateTime(value) {
      if (!value) return '-';
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) return String(value);
      return parsed.toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    },
    scrollToBottom() {
      this.$nextTick(() => {
        const el = this.$refs.messageList;
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
      });
    },
    serializeHistory() {
      return this.messages.slice(-8).map((message) => ({
        role: message.role,
        text: message.text,
      }));
    },
    copyButtonLabel(messageId) {
      if (this.copiedMessageId === messageId) return 'Copiado';
      if (this.copyFailedMessageId === messageId) return 'Erro ao copiar';
      return 'Copiar';
    },
    getCardClasses(card) {
      return [
        {
          'card-item-wide': card?.emphasis === 'wide',
        },
        `card-category-${normalizeCardToken(card?.category)}`,
        `card-tone-${normalizeCardToken(card?.tone)}`,
      ];
    },
    buildCopyText(message) {
      const lines = [message.text || ''];

      (message.cards || [])
        .filter((card) => !/^exemplo\b/i.test(String(card.title || '').trim()))
        .forEach((card) => {
          const tableRows = card.table?.rows?.length
            ? card.table.rows
                .map((row) => (card.table.columns || [])
                  .map((column) => formatCopyValue(row?.[column.key]))
                  .filter((value) => value !== '')
                  .join(' | '))
                .filter(Boolean)
                .join('\n')
            : '';
          const inlineItems = Array.isArray(card.items)
            ? card.items
                .map((item) => item?.document ? `${item.name} - ${item.document}` : item?.name)
                .filter(Boolean)
                .join(' | ')
            : '';

          lines.push(`${card.title}: ${tableRows || inlineItems || card.value}`);
          if (card.note) lines.push(card.note);
        });

      if (message.metadata?.cnpj) lines.push(`CNPJ: ${message.metadata.cnpj}`);
      if (message.metadata?.cardCode) lines.push(`CardCode: ${message.metadata.cardCode}`);
      if (message.metadata?.reportId) lines.push(`Relatorio: ${message.metadata.reportId}`);
      if (message.metadata?.createdAt) lines.push(`Base: ${this.formatDateTime(message.metadata.createdAt)}`);

      return lines.filter(Boolean).join('\n');
    },
    async copyAssistantMessage(message) {
      try {
        await writeTextToClipboard(this.buildCopyText(message));
        this.copiedMessageId = message.id;
        this.copyFailedMessageId = '';
        window.setTimeout(() => {
          if (this.copiedMessageId === message.id) {
            this.copiedMessageId = '';
          }
        }, 1800);
      } catch (err) {
        console.warn('Falha ao copiar resposta do MARCI', err);
        this.copyFailedMessageId = message.id;
        window.setTimeout(() => {
          if (this.copyFailedMessageId === message.id) {
            this.copyFailedMessageId = '';
          }
        }, 2200);
      }
    },
    pushAssistantError(errorMessage) {
      this.messages.push({
        id: createId('assistant'),
        role: 'assistant',
        text: errorMessage,
        sources: [],
        cards: [],
        suggestions: [],
        metadata: {},
      });
      this.scrollToBottom();
    },
    async handleSubmit(prefilledMessage = '') {
      const outgoing = String(prefilledMessage || this.draft).trim();
      if (!outgoing || this.loading) return;

      this.messages.push({
        id: createId('user'),
        role: 'user',
        text: outgoing,
        sources: [],
        cards: [],
        suggestions: [],
        metadata: {},
      });

      this.draft = '';
      this.loading = true;
      this.scrollToBottom();

      try {
        const response = await sendMarciMessage({
          message: outgoing,
          history: this.serializeHistory(),
          policyId: process.env.VUE_APP_GYRA_POLICY_ID,
        });

        const assistantMessage = response?.message || {};
        this.messages.push({
          id: createId('assistant'),
          role: 'assistant',
          text: assistantMessage.answer || 'Nao consegui montar uma resposta para essa consulta.',
          sources: assistantMessage.sources || [],
          cards: assistantMessage.cards || [],
          suggestions: assistantMessage.suggestions || [],
          metadata: assistantMessage.metadata || {},
        });
      } catch (err) {
        this.pushAssistantError(
          err.response?.data?.error || err.message || 'Falha ao processar a consulta do MARCI.'
        );
      } finally {
        this.loading = false;
        this.scrollToBottom();
      }
    },
  },
  mounted() {
    this.scrollToBottom();
  },
};
</script>

<style scoped>
.center-layout {
  display: flex;
  justify-content: center;
  align-items: stretch;
  min-height: calc(100vh - 140px);
}

.marci-shell {
  width: min(1320px, 100%);
  height: calc(100vh - 140px);
}

.marci-panel {
  position: relative;
  overflow: hidden;
  height: 100%;
  padding: 34px;
  border-radius: 32px;
  background:
    radial-gradient(circle at 84% 14%, rgba(255, 214, 90, 0.28), transparent 18%),
    radial-gradient(circle at top left, rgba(255, 202, 43, 0.34), transparent 28%),
    linear-gradient(160deg, rgba(125, 84, 6, 0.98), rgba(33, 22, 5, 0.97));
  border: 1px solid rgba(255, 210, 54, 0.24);
  box-shadow: 0 28px 64px rgba(0, 0, 0, 0.36);
}

.marci-panel::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.06), transparent 30%),
    radial-gradient(circle at 20% 0%, rgba(255, 236, 171, 0.16), transparent 26%),
    linear-gradient(160deg, rgba(255, 206, 55, 0.18), rgba(58, 36, 4, 0.4));
  pointer-events: none;
}

.marci-panel::after {
  content: '';
  position: absolute;
  inset: 0;
  background-image: url('../assets/marci-emblema.png');
  background-repeat: no-repeat;
  background-position: center;
  background-size: cover;
  opacity: 0.11;
  filter: drop-shadow(0 24px 48px rgba(0, 0, 0, 0.26));
  pointer-events: none;
}

.eyebrow,
.overview-shell,
.chat-shell {
  position: relative;
  z-index: 1;
}

.marci-layout {
  display: grid;
  grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
  gap: 26px;
  height: 100%;
}

.overview-shell {
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  min-height: 0;
  padding: 4px 4px 4px 2px;
}

.eyebrow {
  margin: 0 0 6px;
  color: #ffe178;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.headline-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.status-pill,
.status-note,
.chat-badge {
  display: inline-flex;
  align-items: center;
  padding: 7px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.status-pill {
  background: #d9ad1f;
  color: #2c1800;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
}

.status-note {
  background: rgba(255, 244, 202, 0.1);
  color: #fff0ba;
  border: 1px solid rgba(255, 211, 61, 0.16);
}

h1 {
  margin: 0;
  color: #fff8dd;
  font-size: clamp(44px, 6vw, 82px);
  line-height: 0.9;
  letter-spacing: 0.03em;
  text-shadow: 0 4px 18px rgba(0, 0, 0, 0.24);
}

.tagline {
  max-width: 280px;
  margin: 10px 0 0;
  color: #dcb33b;
  font-size: 17px;
  font-weight: 700;
  line-height: 1.25;
}

.chat-shell {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  padding: 16px;
  border-radius: 26px;
  background: linear-gradient(180deg, rgba(30, 21, 7, 0.78), rgba(22, 16, 6, 0.72));
  border: 1px solid rgba(255, 211, 61, 0.2);
  box-shadow: 0 24px 44px rgba(0, 0, 0, 0.22);
  backdrop-filter: blur(10px);
}

.chat-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 12px;
}

.chat-eyebrow {
  margin: 0 0 6px;
  color: #ffd33d;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.chat-header h2 {
  margin: 0;
  color: #fff4c9;
  font-size: 24px;
}

.chat-badge {
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  min-width: 118px;
  background: rgba(255, 242, 192, 0.09);
  color: #fff0ba;
  border: 1px solid rgba(255, 211, 61, 0.16);
}

.chat-badge strong {
  color: #fff8dd;
  font-size: 14px;
  letter-spacing: 0;
}

.message-list {
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 14px;
  min-height: 0;
  padding: 4px 4px 4px 0;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 211, 61, 0.72) rgba(255, 243, 204, 0.08);
}

.message-list::-webkit-scrollbar {
  width: 10px;
}

.message-list::-webkit-scrollbar-track {
  background: rgba(255, 243, 204, 0.08);
  border-radius: 999px;
}

.message-list::-webkit-scrollbar-thumb {
  background: linear-gradient(180deg, rgba(255, 221, 112, 0.95), rgba(214, 144, 12, 0.92));
  border-radius: 999px;
  border: 2px solid rgba(32, 21, 5, 0.55);
}

.message-list::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(180deg, rgba(255, 232, 147, 0.98), rgba(230, 156, 14, 0.95));
}

.message-item {
  display: flex;
}

.message-assistant {
  justify-content: flex-start;
}

.message-user {
  justify-content: flex-end;
}

.message-bubble {
  position: relative;
  width: min(860px, 100%);
  padding: 18px;
  border-radius: 22px;
  border: 1px solid rgba(255, 211, 61, 0.14);
  box-shadow: 0 14px 28px rgba(0, 0, 0, 0.12);
}

.message-assistant .message-bubble {
  background: linear-gradient(180deg, rgba(255, 243, 204, 0.08), rgba(255, 243, 204, 0.05));
}

.message-user .message-bubble {
  width: auto;
  max-width: min(560px, 78%);
  background: linear-gradient(180deg, rgba(214, 166, 32, 0.16), rgba(168, 120, 12, 0.1));
  border-color: rgba(214, 166, 32, 0.24);
}

.loading-bubble {
  opacity: 0.9;
}

.message-actions {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 6px;
}

.copy-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 7px 12px;
  border-radius: 999px;
  border: 1px solid rgba(217, 173, 31, 0.22);
  background: rgba(255, 243, 204, 0.08);
  color: #e2bf62;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: background-color 0.18s ease, border-color 0.18s ease, transform 0.18s ease;
}

.copy-button:hover {
  background: rgba(255, 243, 204, 0.14);
  border-color: rgba(255, 221, 112, 0.42);
  transform: translateY(-1px);
}

.message-role {
  display: inline-block;
  margin-bottom: 8px;
  color: #dcb33b;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.message-user .message-role {
  color: #e2bf62;
}

.message-text {
  margin: 0;
  color: #fff7d8;
  line-height: 1.6;
  white-space: pre-line;
}

.message-user .message-text {
  color: #e2bf62;
  font-weight: 600;
}

.source-row,
.message-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
}

.source-chip {
  display: inline-flex;
  align-items: center;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(217, 173, 31, 0.14);
  color: #e9cc83;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 14px;
  margin-top: 16px;
}

.card-item {
  padding: 16px;
  border-radius: 16px;
  background: rgba(255, 243, 204, 0.06);
  border: 1px solid rgba(255, 211, 61, 0.12);
}

.card-category-gyra {
  border-color: rgba(255, 211, 61, 0.18);
}

.card-category-sap {
  border-color: rgba(145, 191, 255, 0.22);
  background: linear-gradient(145deg, rgba(145, 191, 255, 0.07), rgba(255, 243, 204, 0.045));
}

.card-category-analise {
  border-color: rgba(255, 211, 61, 0.26);
  background: linear-gradient(145deg, rgba(217, 173, 31, 0.11), rgba(255, 243, 204, 0.045));
}

.card-category-status,
.card-tone-pending {
  border-color: rgba(255, 202, 82, 0.34);
  background:
    radial-gradient(circle at top left, rgba(255, 209, 76, 0.16), transparent 46%),
    rgba(255, 243, 204, 0.055);
}

.card-category-acao {
  border-color: rgba(255, 247, 225, 0.2);
  background: linear-gradient(145deg, rgba(255, 247, 225, 0.08), rgba(255, 211, 61, 0.045));
}

.card-tone-warning {
  border-color: rgba(239, 153, 69, 0.36);
  background: linear-gradient(145deg, rgba(163, 74, 40, 0.16), rgba(255, 243, 204, 0.045));
}

.card-tone-insight {
  box-shadow: inset 0 1px 0 rgba(255, 231, 151, 0.08);
}

.card-item-wide {
  grid-column: 1 / -1;
}

.card-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

.card-label {
  display: inline-flex;
  color: #dcb33b;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.card-category {
  flex: 0 0 auto;
  max-width: 92px;
  padding: 3px 7px;
  border-radius: 999px;
  background: rgba(255, 247, 225, 0.08);
  border: 1px solid rgba(255, 247, 225, 0.1);
  color: rgba(255, 247, 225, 0.7);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.07em;
  line-height: 1.2;
  text-align: center;
  text-transform: uppercase;
}

.card-value {
  display: block;
  color: #fff4c9;
  font-size: 19px;
  line-height: 1.4;
}

.card-table {
  display: grid;
  gap: 6px;
  width: 100%;
}

.card-table-header,
.card-table-row {
  display: grid;
  grid-template-columns: minmax(54px, 0.7fr) minmax(82px, 0.95fr) minmax(92px, 0.95fr) minmax(116px, 1.2fr);
  gap: 8px;
  align-items: center;
}

.card-table-metrics .card-table-header,
.card-table-metrics .card-table-row {
  grid-template-columns: minmax(220px, 1fr) minmax(120px, auto);
}

.card-table-header {
  padding: 0 0 4px;
  border-bottom: 1px solid rgba(255, 211, 61, 0.14);
}

.card-table-row {
  padding: 4px 0;
}

.card-table-head-cell {
  color: #dcb33b;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.card-table-cell {
  min-width: 0;
  color: #fff4c9;
  font-size: 13px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.card-status-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 26px;
  padding: 4px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-align: center;
}

.card-status-overdue {
  background: linear-gradient(135deg, rgba(188, 55, 32, 0.3), rgba(220, 164, 34, 0.26));
  border: 1px solid rgba(238, 171, 49, 0.35);
  color: #ffd7a8;
}

.card-status-neutral {
  background: rgba(255, 247, 225, 0.1);
  border: 1px solid rgba(255, 247, 225, 0.14);
  color: rgba(255, 247, 225, 0.88);
}

.card-status-today {
  background: linear-gradient(135deg, rgba(217, 173, 31, 0.3), rgba(255, 223, 118, 0.24));
  border: 1px solid rgba(255, 215, 112, 0.36);
  color: #fff1b8;
  box-shadow: 0 0 0 1px rgba(255, 215, 112, 0.1);
}

.card-inline-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  color: #fff4c9;
  font-size: 13px;
  line-height: 1.3;
  max-width: 100%;
}

.card-inline-item {
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.card-inline-name {
  font-weight: 700;
}

.card-inline-document {
  font-weight: 400;
}

.card-note {
  margin: 8px 0 0;
  color: rgba(255, 247, 225, 0.78);
  line-height: 1.45;
  font-size: 13px;
}

.message-meta span {
  color: rgba(255, 247, 225, 0.74);
  font-size: 13px;
}

.composer {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid rgba(255, 211, 61, 0.12);
}

.composer textarea {
  width: 100%;
  resize: none;
  min-height: 72px;
  padding: 12px 14px;
  box-sizing: border-box;
  max-width: 100%;
  border-radius: 14px;
  border: 1px solid rgba(255, 211, 61, 0.22);
  background: rgba(255, 248, 224, 0.08);
  color: #fff7d8;
  font-size: 14px;
  line-height: 1.4;
}

.composer textarea::placeholder {
  color: rgba(255, 241, 194, 0.5);
}

.composer-footer {
  display: flex;
  justify-content: flex-end;
  gap: 16px;
  align-items: center;
  margin-top: 10px;
}

.composer-hint {
  display: none;
}

.send-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 12px 18px;
  border-radius: 12px;
  border: none;
  font-weight: 700;
  background: #d9ad1f;
  color: #241500;
  box-shadow: 0 10px 22px rgba(0, 0, 0, 0.22);
  transition: transform 0.18s ease, box-shadow 0.18s ease, background-color 0.18s ease;
  cursor: pointer;
}

.send-button:hover {
  transform: translateY(-2px);
  background: #e0b942;
  box-shadow: 0 16px 26px rgba(0, 0, 0, 0.26);
}

.send-button:disabled {
  opacity: 0.7;
  cursor: not-allowed;
  transform: none;
}

@media (max-width: 900px) {
  .marci-shell {
    height: auto;
  }

  .marci-panel {
    height: auto;
    min-height: calc(100vh - 140px);
  }

  .marci-layout {
    grid-template-columns: 1fr;
    gap: 18px;
    height: auto;
  }

  .chat-header,
  .composer-footer {
    flex-direction: column;
    align-items: flex-start;
  }

  .chat-badge {
    align-items: flex-start;
  }

  .marci-panel::after {
    background-size: cover;
    opacity: 0.1;
  }

  .overview-shell {
    padding: 0;
  }

  .tagline {
    max-width: none;
  }
}

@media (max-width: 640px) {
  .marci-panel {
    padding: 22px;
  }

  h1 {
    font-size: 46px;
  }

  .tagline {
    font-size: 18px;
  }

  .chat-shell {
    padding: 16px;
    min-height: 680px;
    height: auto;
  }

  .chat-header h2 {
    font-size: 22px;
  }

  .message-bubble {
    padding: 16px;
  }

  .suggestion-row {
    gap: 8px;
  }
}
</style>
