const express = require('express');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const canvasRoutes = require('../routes/canvasRoutes');

const port = Number(process.argv[2] || 3134);
const outputRoot = path.resolve(process.argv[3] || path.join(__dirname, '..', 'output', 'agent-real-api-acceptance'));
const frontendRoot = path.resolve(__dirname, '..', '..', 'frontend');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(frontendRoot));
app.use(canvasRoutes({ outputRoot }));
app.get('/health', (_req, res) => res.json({ success: true, port, outputRoot }));

app.listen(port, () => {
  console.log(`[AGENT-REAL-ACCEPTANCE] http://127.0.0.1:${port}`);
  console.log(`[AGENT-REAL-ACCEPTANCE] outputRoot=${outputRoot}`);
});
