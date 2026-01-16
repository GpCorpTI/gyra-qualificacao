<template>
  <div id="app" class="layout-wrapper">
    <aside class="sidebar">
      <router-link to="/motorcredito">
        <img src="@/assets/gp_imports_logo.png" alt="Logo" class="logo" />
      </router-link>

      <button class="info-button" @click="showInfo = true">
        <img src="@/assets/Info-icon.png" alt="Info" class="info-icon" />
      </button>
      <InfoModal :visible="showInfo" @close="showInfo = false" />
    </aside>

    <div class="main-section">
      <main class="main-content">
        <router-view />
      </main>
      <footer class="footer">
        © 2026 GP CORP BR - Todos os direitos reservados <br />
        Versão 1.2.2026 - Uso exclusivo GP Corp BR - Desenvolvido pelo Departamento de TI
      </footer>
    </div>

    <!-- InfoModal -->
    <InfoModal v-if="showInfo" @close="showInfo = false" />
  </div>
</template>

<script>
import InfoModal from './components/InfoModal.vue';

export default {
  components: {
    InfoModal
  },
  data() {
    return {
      showInfo: false
    };
  }
};
</script>

<style>
body {
  margin: 0;
  font-family: 'Montserrat', sans-serif;
  background-image: linear-gradient(to bottom, #21364b, #13284a);
}

#app.layout-wrapper {
  display: flex;
  min-height: 100vh;
}

.sidebar {
  position: fixed;
  top: 0; 
  left: 0; 
  bottom: 0;               /* full height */
  z-index: 20;
  width: 60px;
  background-color: #0d1b2a;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px 0;
  gap: 20px;
}

.logo {
  width: 60px;
  height: auto;
}

.info-button {
  background: none;
  border: none;
  font-size: 24px;
  color: #8ecae6;
  cursor: pointer;
}

.info-icon {
  width: 50px;
  height: 50px;
}

.info-button:hover {
  color: white;
}

.main-section {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.main-content {
  flex: 1;
  padding: 2rem;
}


</style>
