import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { secret_key } = req.body;

  if (!secret_key || typeof secret_key !== 'string') {
    return res.status(400).json({ error: 'Secret key required' });
  }

  const { data, error } = await supabase
    .from('clients')
    .select('tenant_id, business_name, status, owner_name')
    .eq('secret_key', secret_key.trim().toUpperCase())
    .single();

  if (error || !data) {
    return res.status(401).json({ error: 'Invalid secret key' });
  }

  if (data.status === 'frozen') {
    return res.status(403).json({ error: 'Account suspended. Contact support.' });
  }

  return res.status(200).json({
    tenant_id: data.tenant_id,
    business_name: data.business_name,
    owner_name: data.owner_name
  });
}
