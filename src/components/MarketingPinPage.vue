<template>
  <div class="pin-page">
    <h2>Digite o PIN de acesso</h2>
    <input v-model="pin" type="password" placeholder="PIN" />
    <button @click="validatePin">Entrar</button>
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<script>
export default {
  name: 'PinMarketing',
  data() {
    return {
      pin: '',
      error: ''
    };
  },
  methods: {
    validatePin() {
      if (this.pin === 'Mkt') {
        const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
        localStorage.setItem('marketingAccessGranted', 'true');
        localStorage.setItem('marketingAccessExpiresAt', expiresAt.toString());
        const redirectPath = localStorage.getItem('redirectAfterPinMarketing') || '/marketing';
        localStorage.removeItem('redirectAfterPinMarketing');
        this.$router.push(redirectPath);
    } else {
        this.error = 'PIN inválido';
    }
    }
  }
}
</script>

<style scoped>
.pin-page {
  max-width: 400px;
  margin: auto;
  padding: 40px;
  background-color: rgba(7, 15, 23, 0.25);
  color: white;
  border-radius: 12px;
  text-align: center;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.6);
}


input {
  padding: 10px;
  font-size: 18px;
  width: 92%;
  margin-bottom: 12px;
}
button {
  padding: 10px 20px;
  font-size: 16px;
  background-color: #0072ff;
  color: white;
  border: none;
  border-radius: 6px;
}
.error {
  color: red;
  margin-top: 10px;
}
</style>
