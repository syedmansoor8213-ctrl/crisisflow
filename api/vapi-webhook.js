import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('nope');

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    const payload = req.body;
    if (payload.type !== 'end-of-call-report') return res.status(200).json({ message: 'ignored' });

    const assistantId = payload?.call?.assistantId;
    if (!assistantId) return res.status(400).json({ error: 'No assistantId' });

    const { data: tenants } = await supabase
      .from('tenants').select('*').eq('vapi_assistant_id', assistantId);

    if (!tenants?.length) return res.status(200).json({ message: 'Tenant not found' });

    const tenant = tenants[0];
    const lead = payload?.analysis?.structuredData || {};
    const category = lead.category || 'Junk';
    const now = new Date().toISOString();

    const record = {
      tenant_id: tenant.id, category,
      name: lead.name||null, phone: lead.phone||null,
      email: lead.email||null, job_type: lead.job_type||null,
      location: lead.location||null, created_at: now
    };

    await supabase.from('leads').insert(record);
    await supabase.from('lead_campaign').insert({
      tenant_id: tenant.id, name: lead.name||null, phone: lead.phone||null,
      email: lead.email||null, job_type: lead.job_type||null,
      location: lead.location||null, category, created_at: now
    });

    if (category === 'Emergency' && tenant.whatsapp_apikey && tenant.whatsapp_phone) {
      const msg = `🚨 *EMERGENCY LEAD*\n\nName: ${lead.name}\nJob: ${lead.job_type}\nLocation: ${lead.location}\n\nCall now: tel:${lead.phone}`;
      const url = `https://api.callmebot.com/whatsapp.php?phone=${tenant.whatsapp_phone.trim()}&text=${encodeURIComponent(msg)}&apikey=${tenant.whatsapp_apikey.trim()}`;
      fetch(url).catch(()=>{});
    }

    return res.status(200).json({ success: true, category });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
