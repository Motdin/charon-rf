import { startCharon } from './src/app.js';

startCharon().catch((error) => {
  console.error(error);
  process.exit(1);
});
