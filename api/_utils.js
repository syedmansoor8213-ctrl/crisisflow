const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Qualify a lead with Gemini ───────────────────────────────────────────────
async function qualify(input, owner) {
  const prompt = `
You analyze emergency service requests for a trades business.

Business service area: ${owner.service_area}, radius: ${owner.radius_miles} miles
Job types they handle: ${(owner.job_types || []).join(', ') || 'general trades'}
Minimum job value: $${owner.min_job_value}

Customer input:
${input}

Respond ONLY with valid JSON, no explanation, no markdown:
{
  "name": "customer name or Unknown",
  "phone": "digits only or null",
  "address": "full address or null",
  "problem": "one sentence summary",
  "in_area": true or false,
  "right_job_type": true or false,
  "urgency": "emergency or qualified or junk",
  "value_min": integer,
  "value_max": integer
}

Rules:
- If address is outside service area: in_area = false, urgency = junk
- If job type doesn't match what they handle: right_job_type = false, urgency = junk
- emergency: active damage happening NOW (flooding, no power, gas leak, lockout), urgency 7+, in area, right type, value above minimum
- qualified: real service need, in area, right type, value above minimum, not actively damaging right now
- junk: spam, outside area, wrong job type, below minimum value, or unclear
`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1 }
        })
      }
    );
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return {
      name: 'Unknown', phone: null, address: null,
      problem: 'Could not parse', in_area: true, right_job_type: true,
      urgency: 'qualified', value_min: 0, value_max: 0
    };
  }
}

// ─── Send SMS via Twilio (only called for emergencies) ────────────────────────
async function sendEmergencySMS(owner, lead) {
  if (!owner.phone) return;

  const msg = `🔴 EMERGENCY
👤 ${lead.customer_name || 'Unknown'}
📍 ${lead.customer_address || 'Unknown'}
🔧 ${lead.problem}
💰 $${lead.value_min}–$${lead.value_max}
📞 ${lead.customer_phone || 'No phone'}
→ Login: ${process.env.BASE_URL}/dashboard.html`;

  try {
    const encoded = new URLSearchParams();
    encoded.append('To', owner.phone);
    encoded.append('From', process.env.TWILIO_FROM);
    encoded.append('Body', msg);

    await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: encoded.toString()
      }
    );
  } catch (err) {
    console.error('SMS failed:', err.message);
  }
}

// ─── Save lead + contact (contact is permanent, lead gets deleted when done) ──
async function saveLead(owner, leadData) {
  const { data: lead } = await supabase
    .from('leads')
    .insert({
      owner_id: owner.id,
      tenant_id: owner.tenant_id,
      customer_name: leadData.name,
      customer_phone: leadData.phone,
      customer_address: leadData.address,
      problem: leadData.problem,
      urgency: leadData.urgency,
      value_min: leadData.value_min,
      value_max: leadData.value_max,
      channel: leadData.channel,
      transcript: leadData.transcript || null
    })
    .select()
    .single();

  // Always save contact permanently regardless of urgency
  await supabase.from('contacts').insert({
    owner_id: owner.id,
    tenant_id: owner.tenant_id,
    customer_name: leadData.name,
    customer_phone: leadData.phone,
    customer_address: leadData.address,
    problem: leadData.problem,
    urgency: leadData.urgency,
    channel: leadData.channel
  });

  return lead;
}

// ─── Verify owner by tenant_id + secret_key ───────────────────────────────────
async function verifyOwner(tenant_id, secret_key) {
  const { data: owner } = await supabase
    .from('owners')
    .select('*')
    .eq('tenant_id', tenant_id)
    .single();

  if (!owner) return null;

  const hash = crypto.createHash('sha256').update(secret_key).digest('hex');
  if (hash !== owner.secret_key_hash) return null;
  if (owner.status === 'frozen') return { ...owner, frozen: true };

  return owner;
}

module.exports = { supabase, qualify, sendEmergencySMS, saveLead, verifyOwner };
