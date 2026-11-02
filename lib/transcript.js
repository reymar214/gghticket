const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function fetchAll(channel, cap = 2000) {
  const all = [];
  let before;
  while (all.length < cap) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    all.push(...batch.values());
    before = batch.last().id;
  }
  return all.reverse(); // oldest first
}

function buildHtml(ticket, messages, info) {
  const num = String(ticket.num).padStart(4, '0');
  const qa = ticket.answers.map((a) => `<div><b>${esc(a.q)}</b><br>${esc(a.a).replace(/\n/g, '<br>')}</div>`).join('');
  const rows = messages.map((m) => {
    const att = [...m.attachments.values()].map((a) =>
      (a.contentType || '').startsWith('image/')
        ? `<img src="${esc(a.url)}" style="max-width:400px;display:block;margin-top:4px">`
        : `<div><a href="${esc(a.url)}">${esc(a.name)}</a></div>`).join('');
    const emb = m.embeds.map((e) => `<div class="embed"><b>${esc(e.title || '')}</b><div>${esc(e.description || '')}</div>${
      (e.fields || []).map((f) => `<div><b>${esc(f.name)}</b>: ${esc(f.value)}</div>`).join('')}</div>`).join('');
    return `<div class="msg"><img class="av" src="${esc(m.author.displayAvatarURL({ size: 64 }))}"><div>
      <span class="name">${esc(m.member?.displayName || m.author.username)}</span>${m.author.bot ? '<span class="tag">BOT</span>' : ''}
      <span class="time">${m.createdAt.toISOString().replace('T', ' ').slice(0, 19)} UTC</span>
      <div>${esc(m.cleanContent).replace(/\n/g, '<br>')}</div>${att}${emb}</div></div>`;
  }).join('\n');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Ticket #${num}</title><style>
body{background:#313338;color:#dbdee1;font-family:system-ui,sans-serif;margin:0;padding:24px}
.head{background:#2b2d31;border-radius:8px;padding:16px;margin-bottom:16px}.head div{margin-top:8px}
.msg{display:flex;gap:12px;margin:12px 0}.av{width:40px;height:40px;border-radius:50%}
.name{font-weight:600;color:#fff}.time{color:#949ba4;font-size:12px;margin-left:8px}
.tag{background:#5865f2;color:#fff;font-size:10px;border-radius:3px;padding:1px 4px;margin-left:6px}
.embed{border-left:4px solid #5865f2;background:#2b2d31;padding:8px 12px;margin-top:4px;border-radius:4px}
a{color:#00a8fc}</style></head><body>
<div class="head"><h2>Ticket #${num}</h2>
<div>Created by: ${esc(ticket.username)} (${esc(ticket.userId)})</div>
<div>Type: ${esc(ticket.type)}</div>${qa}
${info.closer ? `<div>Closed by: ${esc(info.closer)} — ${esc(info.reason)}</div>` : '<div>Still open — live view</div>'}</div>
${rows}</body></html>`;
}

module.exports = { fetchAll, buildHtml };
