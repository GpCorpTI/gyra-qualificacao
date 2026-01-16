// backend/src/services/notifyTeams.js
import axios from 'axios';
import { TEAMS } from '../config/env.js';

// Always send an Adaptive Card (wrapper shape) to match your Flow schema
export async function notifyApprovedUpdate({ reportId, cnpj, cardCode, dateSet }) {
  if (!TEAMS?.url) return;

//   // Plain text fallback (Flow posts this if you route to "Post message" branch)
//   const body = `✅ SAP ATUALIZADO
// - **CNPJ:** ${cnpj}
// - **CardCode:** ${cardCode}
// - **Data:** ${dateSet}
// - **Report ID:** ${reportId}`;

  // Adaptive Card content (same as your test script)
  const pureAdaptiveCard = {
    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [
      { "type": "TextBlock", "text": "✅ SAP ATUALIZADO", "weight": "Bolder", "size": "Medium" },
      { "type": "FactSet", "facts": [
        { "title": "CNPJ", "value": cnpj },
        { "title": "CardCode", "value": cardCode },
        { "title": "Data", "value": dateSet },
        { "title": "Report ID", "value": String(reportId) }
      ]}
    ]
  };

  // Wrapper shape required by your Flow schema:
  // In Flow: Apply to each = triggerBody().attachments  → Post card → Card = items('Apply_to_each')?['content']
  const payload = {
    secret: TEAMS.secret || '',
    // body, // optional fallback
    attachments: [
      { contentType: "application/vnd.microsoft.card.adaptive", content: pureAdaptiveCard }
    ]
  };

  await axios.post(TEAMS.url, payload, { timeout: 15000 });
}
