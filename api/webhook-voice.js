import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function checkUrgencyKeywords(text) {
  const urgencyKeywords = [
    'emergency', 'urgent', 'immediately', 'right now', 'asap',
    'quickly', 'hurry', 'please help', 'desperate', 'serious',
    'really bad', 'flooding', 'no power', 'locked out', 'burst',
    'stranded', 'critical', 'dangerous', 'help me', 'please',
    'bad', 'worst', 'severe', 'quick', 'fast', 'now', 'today',
    'cant wait', "can't wait", 'need someone', 'need help',
    'leaking', 'water everywhere', 'smoke', 'sparking', 'fire',
    'gas leak', 'no heat', 'no cooling', 'broken into', 'stuck',
    'burst pipe', 'burst'
  ];
  const lower = (text || '').toLowerCase();
  return urgencyKeywords.some(kw => lower.includes(kw));
}

async function classifyWithGemini(tenant, summary, caller_name, job_type) {
  const prompt = `You are a lead urgency classifier for a local service business.

Business serves: ${tenant.service_types ? tenant.service_types.join(', ') : 'General Services'}
Business location: ${tenant.service_location || 'Local Area'}
Caller name: ${caller_name || 'Unknown'}
Call label: ${job_type || 'Unknown'}
Call summary: ${summary || 'No summary'}

Classify as URGENT if:
- Active emergency, caller needs someone immediately
- Flooding, no power, locked out, gas leak, burst pipe, or total AC failure in heat
- Tone sounds distressed or panicked

Classify as QUALIFIED if:
- Real job, matches service type and location, but not an immediate emergency

Classify as JUNK if:
- Wrong service, wrong location, spam, or a hang-up

Respond ONLY with valid JSON:
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

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log('Gemini response:', text);

    if (text.includes('"urgent"')) return { class: 'urgent', reason: 'gemini detected crisis' };
    if (text.includes('"junk"')) return { class: 'junk', reason: 'out of scope or spam' };
    return { class: 'qualified', reason: 'valid lead' };

  } catch (err) {
    console.error('Gemini error:', err);
    return { class: 'qualified', reason: 'fallback after error' };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Log everything immediately
  console.log('=== WEBHOOK HIT ===');
  console.log('tenant_id:', req.query.tenant_id);
  console.log('body:', JSON.stringify(req.body));

  // Respond immediately so Ring-Ready doesn't retry
  res.status(200).json({ received: true });

  // Everything below runs after response is sent
  try {
    const tenant_id = req.query.tenant_id;

    if (!tenant_id) {
      console.error('ERROR: No tenant_id in URL');
      return;
    }

    const {
      from_phone_number,
      callback_number,
      caller_name,
      call_label,
      summary
    } = req.body;

    console.log('Parsed fields:', { from_phone_number, callback_number, caller_name, call_label, summary });

    // Fetch tenant
    const { data: tenant, error: tenantError } = await supabase
      .from('clients')
      .select('*')
      .eq('tenant_id', tenant_id)
      .single();

    if (tenantError) {
      console.error('ERROR fetching tenant:', JSON.stringify(tenantError));
      return;
    }

    if (!tenant) {
      console.error('ERROR: Tenant not found for id:', tenant_id);
      return;
    }

    if (tenant.status === 'frozen') {
      console.log('Tenant is frozen, skipping');
      return;
    }

    console.log('Tenant found:', tenant.business_name);

    // Extract location from summary
    const locationRegex = /(?:in|at|near|location:)\s+([A-Za-z\s]+?)(?:\.|,|$)/i;
    const match = summary?.match(locationRegex);
    const extractedLocation = match ? match[1].trim() : (tenant.service_location || 'Unknown');
    console.log('Extracted location:', extractedLocation);

    // Classify urgency
    const hasUrgency = checkUrgencyKeywords(summary);
    let classification;

    if (hasUrgency) {
      classification = { class: 'urgent', reason: 'keyword trigger' };
      console.log('Keyword match — urgent');
    } else {
      classification = await classifyWithGemini(tenant, summary, caller_name, call_label);
    }

    console.log('Classification:', classification);

    // Save lead
    const leadData = {
      tenant_id,
      source: 'call',
      caller_name: caller_name || 'Unknown',
      caller_phone: from_phone_number || null,
      callback_phone: callback_number || from_phone_number || null,
      job_type: call_label || 'General Inquiry',
      location: extractedLocation,
      urgency_class: classification.class,
      ai_summary: summary || 'No summary provided',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    };

    console.log('Saving lead:', JSON.stringify(leadData));

    const { data: insertedLead, error: leadInsertError } = await supabase
      .from('leads')
      .insert(leadData)
      .select();

    if (leadInsertError) {
      console.error('ERROR saving lead:', JSON.stringify(leadInsertError));
      return;
    }

    console.log('Lead saved successfully:', insertedLead?.[0]?.id);

    // Save campaign contact
    const finalPhone = callback_number || from_phone_number;
    const finalName  = caller_name || 'Unknown';

    if (finalPhone && finalName !== 'Unknown') {
      const { error: contactError } = await supabase
        .from('campaign_contacts')
        .insert({
          tenant_id,
          name: finalName,
          phone: finalPhone,
          service_type: call_label || 'General',
          source: 'call'
        });

      if (contactError) {
        console.error('ERROR saving campaign contact:', JSON.stringify(contactError));
      } else {
        console.log('Campaign contact saved');
      }
    }

    console.log('=== WEBHOOK COMPLETE ===');

  } catch (err) {
    console.error('=== UNHANDLED ERROR IN WEBHOOK ===', err);
  }
}
