const { supabase } = require('./_utils');

module.exports = async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }
  // Delete leads marked done that are older than 24 hours
  await supabase.from('leads')
    .delete()
    .eq('status', 'done')
    .lt('created_at', new Date(Date.now() - 86400000).toISOString());

  return res.status(200).json({ ok: true });
};
