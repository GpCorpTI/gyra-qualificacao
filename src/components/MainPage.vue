<template>
  <div class="center-layout">
    <div class="launcher-shell">
      <div class="hero-block">
        <p class="eyebrow">Plataforma GP Corp BR</p>
        <h1>Painel principal</h1>
        <p class="subtitle">
          Escolha o ambiente que deseja acessar para iniciar seu fluxo de trabalho.
        </p>
      </div>

      <div class="card-grid">
        <router-link class="launch-card" :to="{ name: 'home' }">
          <span class="launch-icon">📊</span>
          <div class="launch-copy">
            <h2>Motor de Crédito</h2>
            <p>
              Acesse as consultas de crédito, relatórios, marketing e comercial que já fazem parte do sistema.
            </p>
          </div>
        </router-link>

        <router-link class="launch-card order-card" :to="{ name: 'liberacaoPedido' }">
          <span class="launch-icon">✅</span>
          <div class="launch-copy">
            <h2>LIBERAÇÃO DE PEDIDO</h2>
            <p>
              Verifique se o cliente foi aprovado na política de liberação e atualize o CRM B1 da Arkab.
            </p>
          </div>
        </router-link>

        <router-link class="launch-card marci-card" :to="{ name: 'pinMarci' }">
          <span class="launch-icon">🚘</span>
          <div class="launch-copy">
            <h2>MARCI</h2>
            <p>
              Entre no novo assistente para buscar informações operacionais e, em seguida, consultar dados do Gyra ou do SAP Service Layer.
            </p>
          </div>
        </router-link>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'MainPage'
}
</script>

<style scoped>
.center-layout {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: calc(100vh - 150px);
}

.launcher-shell {
  width: min(1040px, 100%);
  padding: 18px;
}

.hero-block {
  margin-bottom: 28px;
  padding: 32px;
  border-radius: 20px;
  background:
    linear-gradient(135deg, rgba(20, 43, 78, 0.96), rgba(9, 18, 30, 0.88)),
    linear-gradient(120deg, rgba(142, 202, 230, 0.12), transparent 60%);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
}

.eyebrow {
  margin: 0 0 12px;
  color: #8ecae6;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

h1 {
  margin: 0 0 12px;
  color: #fff;
  font-size: clamp(36px, 5vw, 54px);
  line-height: 1;
}

.subtitle {
  max-width: 720px;
  margin: 0;
  color: rgba(255, 255, 255, 0.8);
  font-size: 18px;
  line-height: 1.5;
}

.card-grid {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.launch-card {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 22px 26px;
  border-radius: 10px;
  text-decoration: none;
  color: white;
  background-color: #111b2e8c;
  font-family: 'Montserrat', sans-serif;
  transition: background-color 0.3s ease, transform 0.2s ease;
}

.launch-card:hover {
  background-color: #415a77;
  transform: translateY(-2px);
}

.marci-card {
  background-color: rgba(255, 211, 61, 0.34);
}

.order-card {
  background-color: rgba(32, 155, 103, 0.35);
}

.order-card:hover {
  background-color: #2f6f4f;
}

.marci-card:hover {
  background-color: #817b1c;
}

.launch-icon {
  flex: 0 0 auto;
  font-size: 28px;
  line-height: 1;
}

.launch-copy {
  width: 100%;
  text-align: center;
}

h2 {
  margin: 0;
  color: #fff;
  font-size: 24px;
}

.launch-card p {
  margin: 8px 0 0;
  color: rgba(255, 255, 255, 0.84);
  line-height: 1.5;
  font-size: 15px;
}

@media (max-width: 640px) {
  .launcher-shell {
    padding: 0;
  }

  .hero-block,
  .launch-card {
    padding: 22px;
  }

  h2 {
    font-size: 22px;
  }
}
</style>
