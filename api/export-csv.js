import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { tenant_id, secret_key } = req.query;

  if (!tenant_id || !secret_key) return res.status(401).end();

  const { data: tenant } = await supabase
    .from('clients')
    .select('tenant_id')
    .eq('tenant_id', tenant_id)
    .eq('secret_key', secret_key.toUpperCase())
    .single();

  if (!tenant) return res.status(401).end();

  const { data } = await supabase
    .from('campaign_contacts')
    .select('name, phone, service_type, source, saved_at')
    .eq('tenant_id', tenant_id)
    .order('saved_at', { ascending: false });

  const rows = data || [];
  const csv = [
    ['Name', 'Phone', 'Service Type', 'Source', 'Date'].join(','),
    ...rows.map(r => [
      `"${r.name || ''}"`,
      `"${r.phone || ''}"`,
      `"${r.service_type || ''}"`,
      `"${r.source || ''}"`,
      `"${new Date(r.saved_at).toLocaleDateString()}"`
    ].join(','))
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="campaign-contacts.csv"');
  return res.send(csv);
}
