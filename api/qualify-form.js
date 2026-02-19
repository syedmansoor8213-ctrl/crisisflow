import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { tenant_id, name, phone, service_type, location } = req.body;

  if (!tenant_id || !name || !phone || !service_type || !location) {
    return res.status(400).json({ qualified: false, reason: 'Missing fields' });
  }

  const { data: tenant } = await supabase
    .from('clients')
    .select('service_types, service_location, gemini_api_key, status')
    .eq('tenant_id', tenant_id)
    .single();

  if (!tenant || tenant.status === 'frozen') {
    return res.status(404).json({ qualified: false, reason: 'Not found' });
  }

  const prompt = `A person is submitting a service request form.

Business serves: ${tenant.service_types.join(', ')}
Business location: ${tenant.service_location}

Caller's requested service: ${service_type}
Caller's location: ${location}

Does this request match the business's service types AND service area?
Answer ONLY with valid JSON:
{"match": true} or {"match": false}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${tenant.gemini_api_key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 20 }
      })
    }
  );

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{"match":false}';

  try {
    const clean = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);
    return res.status(200).json({ qualified: result.match === true });
  } catch {
    return res.status(200).json({ qualified: false });
  }
}
