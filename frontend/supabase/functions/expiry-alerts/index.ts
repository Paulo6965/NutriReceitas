// NutriReceitas — Edge Function "expiry-alerts"
// Roda 1x por dia (agendada pelo pg_cron, ver docs/BANCO-DE-DADOS.md):
//   1. busca itens do estoque que vencem dentro da antecedência escolhida por cada pessoa;
//   2. cria avisos na tabela `notifications` (aparecem no sininho do site);
//   3. envia UM e-mail-resumo por pessoa (via Resend), se ela ativou o aviso por e-mail.
//
// Variáveis de ambiente (Supabase → Project Settings → Edge Functions → Secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, MAIL_FROM (ex.: "NutriReceitas <avisos@seudominio.com>"), SITE_URL
//
// Deploy:  supabase functions deploy expiry-alerts --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const MAIL_FROM = Deno.env.get("MAIL_FROM") ?? "NutriReceitas <avisos@nutrireceitas.app>";
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://nutrireceitas.app";

type Item = { id: number; user_id: string; name: string; qty: number; unit: string; expires_on: string };

const daysLeft = (iso: string) => {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  return Math.round((new Date(iso + "T00:00:00Z").getTime() - today.getTime()) / 86400000);
};
const statusOf = (d: number) => (d < 0 ? "expired" : d === 0 ? "today" : "soon");
const titleOf = (i: Item, d: number) =>
  d < 0 ? `${i.name} venceu` : d === 0 ? `${i.name} vence hoje` : d === 1 ? `${i.name} vence amanhã` : `${i.name} vence em ${d} dias`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

Deno.serve(async () => {
  // Preferências de todas as pessoas (padrão: site + e-mail, 3 dias)
  const { data: prefs } = await supabase.from("notification_prefs").select("user_id, site, email, days");
  const prefOf = new Map((prefs ?? []).map((p) => [p.user_id, p]));

  // Itens com validade até daqui a 7 dias (o máximo que alguém pode escolher)
  const limit = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const { data: items, error } = await supabase
    .from("stock_items").select("id, user_id, name, qty, unit, expires_on")
    .not("expires_on", "is", null).lte("expires_on", limit).gt("qty", 0);
  if (error) return new Response(error.message, { status: 500 });

  // Agrupa por pessoa, respeitando a antecedência de cada uma
  const byUser = new Map<string, { item: Item; d: number }[]>();
  for (const item of (items ?? []) as Item[]) {
    const p = prefOf.get(item.user_id) ?? { site: true, email: true, days: 3 };
    const d = daysLeft(item.expires_on);
    if (d > p.days) continue;
    if (!byUser.has(item.user_id)) byUser.set(item.user_id, []);
    byUser.get(item.user_id)!.push({ item, d });
  }

  let created = 0, emailed = 0;
  for (const [userId, list] of byUser) {
    const p = prefOf.get(userId) ?? { site: true, email: true, days: 3 };

    // Cria os avisos (a chave única evita repetir o mesmo aviso no dia seguinte)
    const rows = list.map(({ item, d }) => ({
      user_id: userId, stock_item_id: item.id, status: statusOf(d),
      key: `${item.id}:${statusOf(d)}:${item.expires_on}`,
      title: titleOf(item, d),
      body: d < 0 ? "Confira se ainda está bom para consumo antes de usar." : `Você tem ${item.qty} ${item.unit}. Que tal uma receita para aproveitar?`,
      show_on_site: p.site,
    }));
    const { data: inserted } = await supabase.from("notifications")
      .upsert(rows, { onConflict: "user_id,key", ignoreDuplicates: true }).select("id, title, body, key");
    const fresh = inserted ?? [];
    created += fresh.length;

    // E-mail-resumo só com os avisos NOVOS de hoje
    if (!p.email || !fresh.length || !RESEND_API_KEY) continue;
    const { data: user } = await supabase.auth.admin.getUserById(userId);
    const to = user?.user?.email; if (!to) continue;
    const name = (user.user.user_metadata?.name ?? "Chef").split(" ")[0];
    const subject = fresh.length === 1 ? `⏰ ${fresh[0].title}` : `⏰ ${fresh.length} itens do seu estoque precisam de atenção`;
    const html = `
      <div style="background:#F3EFE8;padding:24px;font-family:Arial,sans-serif">
        <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;border-collapse:collapse">
          <tr><td style="background:#10301F;padding:22px 24px;color:#fff;font:bold 20px Georgia,serif">🌿 NutriReceitas</td></tr>
          <tr><td style="padding:24px 24px 8px;color:#24190F"><p style="margin:0 0 6px;font:bold 20px Georgia,serif">Olá, ${esc(name)}! ⏰</p>
            <p style="margin:0;font-size:15px;color:#43372D">Alguns itens do seu estoque estão perto do vencimento. Aproveite antes de estragar.</p></td></tr>
          ${fresh.map((n) => `<tr><td style="padding:12px 24px;border-bottom:1px solid #ECE5DB;font-size:15px"><b>${esc(n.title)}</b><br><span style="color:#6A5D51;font-size:13px">${esc(n.body)}</span></td></tr>`).join("")}
          <tr><td style="padding:20px 24px 28px" align="center"><a href="${SITE_URL}/#results-section" style="background:#1F5038;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:10px">Ver receitas para aproveitar</a></td></tr>
          <tr><td style="padding:16px 24px;background:#F8F2EB;color:#6A5D51;font-size:12px">Para mudar os avisos, abra o sininho 🔔 no site.</td></tr>
        </table>
      </div>`;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: MAIL_FROM, to, subject, html }),
    });
    if (res.ok) {
      emailed++;
      await supabase.from("notifications").update({ emailed_at: new Date().toISOString() }).in("id", fresh.map((n) => n.id));
    }
  }

  return Response.json({ users: byUser.size, notifications: created, emails: emailed });
});
