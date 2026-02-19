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

  // IMPROVED PROMPT — much more forgiving and explicit
  const prompt = `You are checking if a service request is within a business's coverage area and service types.

Business registered services: ${tenant.service_types.join(', ')}
Business registered location/area: ${tenant.service_location}

Customer requested service: ${service_type}
Customer location: ${location}

Rules for matching:
- Location matches if the customer is in the same city, nearby city, or same general area. Be generous with location matching. "Islamabad" matches "Islamabad", "Islamabad, Pakistan", "F-7 Islamabad", etc.
- Service matches if it is related to or similar to any of the registered services. Be generous. "pipe issue" matches "plumbing". "AC not working" matches "HVAC".
- Only return false if the location is clearly a completely different city/country AND the service is completely unrelated.
- When in doubt, return true.

Respond ONLY with one of these two exact strings, nothing else:
{"match": true}
{"match": false}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${tenant.gemini_api_key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 30  // Force very short response
          }
        })
      }
    );

    const data = await response.json();

    // DEBUG — log what Gemini actually returns
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log('Gemini raw response:', raw);

    // Try to find match value anywhere in the response
    if (raw.includes('"match": true') || raw.includes('"match":true')) {
      return res.status(200).json({ qualified: true });
    }

    if (raw.includes('"match": false') || raw.includes('"match":false')) {
      return res.status(200).json({ qualified: false });
    }

    // If Gemini returns something unexpected, DEFAULT TO TRUE
    // Better to let someone through than wrongly reject them
    console.log('Gemini gave unexpected response, defaulting to qualified=true');
    return res.status(200).json({ qualified: true });

  } catch (err) {
    console.error('Gemini call failed:', err);
    // If Gemini fails entirely, DEFAULT TO TRUE — don't punish the customer
    return res.status(200).json({ qualified: true });
  }
}
