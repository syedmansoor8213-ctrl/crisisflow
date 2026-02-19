import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('nope');
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) return res.status(401).send('unauthorized');

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { type } = req.body;
  const { data: tenants } = await supabase.from('tenants').select('*').eq('pulse_enabled', true).eq('status', 'active');

  for (const tenant of (tenants || [])) {
    try {
      const today = new Date(); today.setHours(0,0,0,0);
      const { data: leads } = await supabase.from('leads').select('*')
        .eq('tenant_id', tenant.id).gte('created_at', today.toISOString());

      if (!leads?.length) continue;

      const emergency = leads.filter(l=>l.category==='Emergency');
      const qualified = leads.filter(l=>l.category==='Qualified');

      let body = type === 'morning'
        ? `Good morning, ${tenant.company_name}!\n\nYour Morning Briefing:\n\n` +
          (emergency.length ? `🚨 EMERGENCY (${emergency.length}):\n${emergency.map(l=>`• ${l.name} | ${l.phone} | ${l.job_type} | ${l.location}`).join('\n')}\n\n` : '') +
          (qualified.length ? `✅ QUALIFIED (${qualified.length}):\n${qualified.map(l=>`• ${l.name} | ${l.phone} | ${l.job_type}`).join('\n')}\n\n` : '') +
          `Total: ${leads.length} leads today.\n\n— CrisisFlow`
        : `Good evening, ${tenant.company_name}!\n\nToday's Summary:\nTotal: ${leads.length}\nEmergency: ${emergency.length}\nQualified: ${qualified.length}\nQuality Score: ${leads.length>0?Math.round((emergency.length+qualified.length)/leads.length*10):0}/10\n\n— CrisisFlow`;

      if (tenant.brevo_smtp_key && tenant.brevo_user) {
        const t = nodemailer.createTransport({ host:'smtp-relay.brevo.com', port:587, secure:false, auth:{user:tenant.brevo_user, pass:tenant.brevo_smtp_key} });
        await t.sendMail({ from:`"${tenant.company_name}" <${tenant.brevo_user}>`, to:tenant.owner_email, subject: type==='morning'?`☀️ Morning Pulse — ${leads.length} leads`:`🌙 Evening Summary — ${leads.length} leads`, text:body });
      }
    } catch(e) { console.error(tenant.company_name, e.message); }
  }

  return res.status(200).json({ done: true });
}
