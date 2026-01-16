import app from './app.js';
import { PORT } from './config/env.js';

app.listen(PORT, () => {
  console.log(`✅ Backend API ready at http://localhost:${PORT}`);
});
