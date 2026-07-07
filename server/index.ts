import { loadConfig } from './config';
import { createApp } from './app';

const config = loadConfig();
const app = createApp(config);

app.listen(config.port, () => {
  console.log(`pdf-signer API listening on port ${config.port}`);
});
