import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { tenant_id, name, phone, service_type, location, description } = req.body;

  if (!tenant_id || !phone || !description) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const { data: tenant } = await supabase
    .from('clients')
    .select('*')
    .eq('tenant_id', tenant_id)
    .single();

  if (!tenant || tenant.status === 'frozen') {
    return res.status(404).json({ error: 'Not found' });
  }

  // ─── STEP 1: KEYWORD PRE-CHECK (instant, free, reliable) ───
  const urgencyKeywords = [
    'emergency', 'urgent', 'immediately', 'right now', 'asap',
    'quickly', 'hurry', 'please help', 'desperate', 'serious',
    'really bad', 'flooding', 'no power', 'locked out', 'burst',
    'stranded', 'critical', 'dangerous', 'help me', 'please',
    'bad', 'worst', 'severe', 'quick', 'fast', 'now', 'today',
    'cant wait', "can't wait", 'need someone', 'need help'
  ];

  const descLower = (description || '').toLowerCase();
  const hasUrgencyKeyword = urgencyKeywords.some(kw => descLower.includes(kw));

  let classification;

  if (hasUrgencyKeyword) {
    // Don't call Gemini — keyword says it's urgent
    classification = { class: 'urgent', reason: 'urgency keywords detected in description' };
  } else {
    // ─── STEP 2: GEMINI FOR AMBIGUOUS CASES ───
    const prompt = `You are a lead urgency classifier for a local service business.

Business serves: ${tenant.service_types.join(', ')}
Business location: ${tenant.service_location}
Caller name: ${name}
Service requested: ${service_type}
Their location: ${location}
Their description: ${description}

Classify as URGENT if ANY of these are true:
- They used words like: emergency, urgent, immediately, right now, ASAP, quickly, hurry, help, please, desperate, serious, bad, critical
- They described something that could cause damage or safety risk if not fixed soon
- The tone sounds distressed or panicked
- AC or heating failure during extreme weather
- No power, no heat, no cooling
- Active leaking, flooding, or water damage
- Locked out right now
- Vehicle stranded

Classify as QUALIFIED if:
- Real job, right service, right location, no urgency signals above

Classify as JUNK if:
- Wrong location, wrong service, spam, not a real job

Respond ONLY with valid JSON, nothing else:
{"class": "urgent", "reason": "brief reason"}`;

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${tenant.gemini_api_key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 100 }
          })
        }
      );

      const geminiData = await response.json();
      const text = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text
        || '{"class":"qualified","reason":"fallback"}';

      console.log('Gemini raw response:', text);

      // Safe parse — check string content first
      if (text.includes('"class": "urgent"') || text.includes('"class":"urgent"')) {
        classification = { class: 'urgent', reason: 'gemini classified urgent' };
      } else if (text.includes('"class": "junk"') || text.includes('"class":"junk"')) {
        classification = { class: 'junk', reason: 'gemini classified junk' };
      } else {
        // Try full JSON parse as fallback
        try {
          classification = JSON.parse(text.replace(/```json|```/g, '').trim());
        } catch {
          classification = { class: 'qualified', reason: 'parse fallback' };
        }
      }
    } catch (err) {
      console.error('Gemini failed:', err);
      // Gemini down — default to qualified, never reject
      classification = { class: 'qualified', reason: 'gemini error fallback' };
    }
  }

  // ─── STEP 3: SAVE LEAD ───
  const lead = {
    tenant_id,
    source: 'form',
    caller_name: name,
    caller_phone: phone,
    callback_phone: phone,
    job_type: service_type,
    location,
    urgency_class: classification.class,
    ai_summary: description,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  };

  await supabase.from('leads').insert(lead);

  // ─── STEP 4: ALERT IF URGENT ───
  if (classification.class === 'urgent') {
    const message = `URGENT FORM LEAD\nName: ${name}\nPhone: ${phone}\nService: ${service_type}\nLocation: ${location}\nDescription: ${description}`;

    // Resend email (primary)
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'alerts@yourdomain.com',
        to: tenant.owner_email,
        subject: `🚨 URGENT FORM LEAD — ${name}`,
        text: message
      })
    }).catch(e => console.error('Resend failed:', e));

    // WaSender WhatsApp (backup)
    await fetch('https://wasenderapi.com/api/send-message', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WASENDER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sessionId: process.env.WASENDER_SESSION_ID,
        to: tenant.owner_whatsapp,
        text: message
      })
    }).catch(e => console.error('WaSender failed:', e));
  }

  return res.status(200).json({ success: true, urgency: classification.class });
}
