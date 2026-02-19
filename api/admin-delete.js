import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'DELETE') return res.status(405).end();
  if (req.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD) return res.status(401).end();

  const { tenant_id } = req.body;
  if (!tenant_id) return res.status(400).end();

  // Cascade delete handles leads + campaign_contacts automatically
  const { error } = await supabase
    .from('clients')
    .delete()
    .eq('tenant_id', tenant_id);

  if (error) return res.status(500).json({ error: 'Failed' });
  return res.status(200).json({ success: true });
}
