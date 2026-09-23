// Basketball Money — payment server.
//
// Deployed as a Render "Web Service" (not a static site). The Stripe
// secret key lives here in Render's environment variables, never in
// the browser.
//
// Two jobs:
//
// 1. POST /create-checkout-session — the Buy button calls this. It
//    looks up the real price from card_designs (never trusts a price
//    sent by the browser), then asks Stripe to open a hosted Checkout
//    page and returns that page's URL.
//
// 2. POST /webhook — Stripe calls this server-to-server only when a
//    payment genuinely succeeded. The card and its tabs are created
//    HERE, never by the browser. That's what stops anyone minting
//    free cards by calling the API directly. The 50/50 split is also
//    calculated and frozen here.

const express = require('express');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const app = express();

// Where card links point. Set CARD_BASE_URL in Render to your public
// site (e.g. https://gostardigital.com). No trailing slash.
const CARD_BASE_URL = (process.env.CARD_BASE_URL || 'https://gostardigital.com').replace(/\/$/, '');
// Where a padrino goes to pay. Their email links here rather than
// straight to Stripe, so one address stays meaningful for the life of
// the pledge — including after it closes.
const PAY_BASE = {
  school: (process.env.PAY_BASE_SCHOOL || 'https://cadapunto.com').replace(/\/$/, ''),
  basketball: (process.env.PAY_BASE_BASKETBALL || 'https://hoops.cash').replace(/\/$/, ''),
};
const BASKETBALL_GAMES = ['cashrack', 'spots'];

const MAIL_FROM = process.env.MAIL_FROM || 'Cada Punto <onboarding@resend.dev>';
// Card emails come from a send-only address. Replies need somewhere
// real to land, so point them at an inbox that is actually read.
const MAIL_REPLY_TO = process.env.MAIL_REPLY_TO || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY;

// Stripe's webhook needs the raw, unparsed body to verify its
// signature, so this route is declared BEFORE express.json() and
// handles its own raw body. Moving this below express.json() breaks
// signature verification with a confusing error.
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send('Invalid signature');
  }

  // A payment link being paid arrives as a completed checkout session
  // carrying the pledge id we attached when the link was made.
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const pledgeId = session.metadata && session.metadata.pledge_id;

    if (pledgeId) {
      try {
        await supabase
          .from('pledges')
          .update({ invoice_status: 'paid', paid_at: new Date().toISOString() })
          .eq('id', pledgeId);
        console.log(`Pledge ${pledgeId} paid by link`);
      } catch (e) {
        console.error('Could not mark pledge paid:', e);
        return res.status(500).send('Failed to record payment');
      }

      // The thank-you. Sent after the pledge is recorded, and never
      // allowed to fail the webhook — a padrino who does not get a
      // thank-you is a small thing; Stripe retrying a payment we have
      // already recorded is not.
      try {
        await sendThankYou(pledgeId);
      } catch (e) {
        console.error(`Thank-you email failed for pledge ${pledgeId}:`, e.message);
      }

      return res.status(200).send('ok');
    }
    // No pledge id means this is a card or licence purchase, which the
    // handler further down deals with.
  }

  // Kept for any invoice still outstanding from before links.
  if (event.type === 'invoice.paid') {
    const inv = event.data.object;
    try {
      await supabase
        .from('pledges')
        .update({ invoice_status: 'paid', paid_at: new Date().toISOString() })
        .eq('stripe_invoice_id', inv.id);
      console.log(`Pledge invoice ${inv.id} marked paid`);
    } catch (e) {
      console.error('Could not mark pledge paid:', e);
      return res.status(500).send('Failed to record payment');
    }
    return res.status(200).send('ok');
  }

  if (event.type === 'invoice.payment_failed') {
    const inv = event.data.object;
    try {
      await supabase
        .from('pledges')
        .update({ invoice_status: 'failed' })
        .eq('stripe_invoice_id', inv.id);
    } catch (e) { console.error('Could not mark pledge failed:', e); }
    return res.status(200).send('ok');
  }

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).send('ok');
  }

  const session = event.data.object;
  const designId = session.metadata?.design_id;
  const campaignId = session.metadata?.campaign_id;
  const playerId = session.metadata?.player_id || null;
  const buyerName = session.metadata?.buyer_name || 'Supporter';
  const buyerEmail = session.customer_details?.email || null;

  if (!designId || !campaignId) {
    console.error('Webhook fired without design_id or campaign_id in metadata');
    return res.status(400).send('Missing metadata');
  }

  try {
    // Re-read the design so the money is calculated from the database,
    // not from anything that travelled through the browser.
    const { data: design, error: designErr } = await supabase
      .from('card_designs')
      .select('id, tab_count, price, team_share_pct, offer_text, valid_when, expires_on, kind, license_product, redeem_url, merchants(name)')
      .eq('id', designId)
      .single();

    if (designErr || !design) throw designErr || new Error('Design not found');

    design.merchant_name = design.merchants?.name || 'Basketball Money';

    // player name, for the email copy only
    design.player_name = null;
    if (playerId) {
      const { data: p } = await supabase.from('players').select('name').eq('id', playerId).single();
      if (p) design.player_name = p.name;
    }

    // How many cards were bought. Read from the line item so it is
    // Stripe's own record, not anything the browser claimed.
    let quantity = 1;
    try {
      const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
      quantity = items.data[0]?.quantity || 1;
    } catch (e) {
      console.error('Could not read quantity, defaulting to 1:', e.message);
    }

    // amount_total covers every card, so divide to get the per-card
    // price before splitting it.
    const totalPaid = Number(session.amount_total) / 100;
    const pricePaid = +(totalPaid / quantity).toFixed(2);
    const teamAmount = +(pricePaid * (design.team_share_pct / 100)).toFixed(2);
    const platformAmount = +(pricePaid - teamAmount).toFixed(2);

    // One row per card, each with its own token. card_index makes the
    // rows distinct within the session, so a repeated webhook delivery
    // still collides on the unique constraint instead of duplicating.
    // A card lasts a year from purchase, unless the merchant set an
    // earlier end date on the design — then whichever comes first.
    const oneYear = new Date();
    oneYear.setFullYear(oneYear.getFullYear() + 1);
    let expiresOn = oneYear.toISOString().slice(0, 10);
    if (design.expires_on && design.expires_on < expiresOn) {
      expiresOn = design.expires_on;
    }

    const cardRows = Array.from({ length: quantity }, (_, i) => ({
      design_id: design.id,
      expires_on: expiresOn,
      campaign_id: campaignId,
      player_id: playerId || null,
      card_token: randToken(),
      card_index: i + 1,
      buyer_name: buyerName,
      buyer_email: buyerEmail,
      price_paid: pricePaid,
      team_amount: teamAmount,
      platform_amount: platformAmount,
      payment_status: 'paid',
      stripe_session_id: session.id,
    }));

    const { data: cards, error: cardErr } = await supabase
      .from('cards')
      .insert(cardRows)
      .select();

    if (cardErr) {
      // 23505 = unique violation. Stripe delivers the same event more
      // than once by design. This session's cards already exist, so
      // this is not a failure — acknowledge and stop.
      if (cardErr.code === '23505') {
        console.log(`Session ${session.id} already processed, skipping`);
        return res.status(200).send('ok (already processed)');
      }
      throw cardErr;
    }

    if (design.kind === 'license') {
      // A license has no coupons. Each purchased card becomes a row in
      // the shared licenses table, so the product's own gate accepts it
      // with no integration between the two systems.
      const licenseRows = cards.map(c => ({
        code: c.card_token,
        product: design.license_product,
        school_name: buyerName || 'Supporter',
        expires_at: c.expires_on,
        active: true,
        // Sold licenses are device-capped; codes created by hand in
        // the license admin stay unlimited, since those are used for
        // recruiting schools and running free trials.
        max_devices: 5,
        notes: 'Purchased through Basketball Money'
      }));

      const { error: licErr } = await supabase.from('licenses').insert(licenseRows);
      if (licErr) throw licErr;
    } else {
      // Every tab for every card, inserted in one request rather than
      // one per tab. A 32-tab card at quantity 5 is 160 rows.
      const tabRows = [];
      for (const c of cards) {
        for (let i = 0; i < design.tab_count; i++) {
          tabRows.push({ card_id: c.id, tab_number: i + 1, status: 'sealed' });
        }
      }

      const { error: tabsErr } = await supabase.from('card_tabs').insert(tabRows);
      if (tabsErr) throw tabsErr;
    }

    const card = cards[0];

    console.log(`${cards.length} card(s) created — ${cards.map(c => c.card_token).join(', ')} — ${design.tab_count} tabs each, $${(teamAmount * cards.length).toFixed(2)} to team, payment ${session.id}`);

    // Email the buyer their card link. Deliberately after the card
    // exists and wrapped in its own try/catch: a mail outage must
    // never make this webhook fail and trigger a Stripe retry on a
    // card that was already created.
    if (buyerEmail) {
      try {
        await sendCardEmail({
          to: buyerEmail,
          buyerName,
          tokens: cards.map(c => c.card_token),
          merchantName: design.merchant_name,
          offerText: design.offer_text,
          validWhen: design.valid_when,
          tabCount: design.tab_count,
          playerName: design.player_name,
          expiresOn,
          kind: design.kind,
          redeemUrl: design.redeem_url,
        });
        console.log(`Card link emailed to ${buyerEmail}`);
      } catch (mailErr) {
        console.error('Card created but email failed:', mailErr.message);
      }
    } else {
      console.log('No buyer email on session — card link not emailed');
    }

    res.status(200).send('ok');
  } catch (e) {
    console.error('Could not create card after payment:', e);
    // A non-200 makes Stripe retry automatically. Worth doing: real
    // money already moved, so the card genuinely needs to exist.
    res.status(500).send('Failed to create card');
  }
});

// Every other route gets normal JSON body parsing.
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  // Authorization is needed too — the invoicing endpoint is called with
  // the admin's own Supabase token, and a header the browser has not
  // been told is allowed fails the preflight check before the real
  // request is ever sent.
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { design_id, campaign_id, player_id, buyer_name, quantity, success_url, cancel_url } = req.body;
    if (!design_id) return res.status(400).json({ error: 'design_id is required' });
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id is required' });

    // Clamp to something sane. The real quantity is read back from
    // Stripe in the webhook, so this is only the starting value.
    const qty = Math.min(Math.max(parseInt(quantity, 10) || 1, 1), 20);

    // Price comes from the database, never from the browser.
    const { data: design, error: designErr } = await supabase
      .from('card_designs')
      .select('id, name, tab_count, price, offer_text, active, merchants(name)')
      .eq('id', design_id)
      .single();

    if (designErr || !design) return res.status(404).json({ error: 'Card design not found' });
    if (design.active === false) return res.status(400).json({ error: 'This card is no longer available' });

    const { data: campaign, error: campaignErr } = await supabase
      .from('campaigns')
      .select('id, name')
      .eq('id', campaign_id)
      .single();

    if (campaignErr || !campaign) return res.status(404).json({ error: 'Campaign not found' });

    const merchantName = design.merchants?.name || 'Basketball Money';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${merchantName} — ${design.tab_count}-tab BOGO card`,
            description: `${design.offer_text} · Supporting ${campaign.name}`,
          },
          unit_amount: Math.round(Number(design.price) * 100),
        },
        quantity: qty,
        adjustable_quantity: { enabled: true, minimum: 1, maximum: 20 },
      }],
      metadata: {
        design_id: String(design_id),
        campaign_id: String(campaign_id),
        player_id: player_id ? String(player_id) : '',
        buyer_name: buyer_name || 'Supporter',
      },
      success_url: success_url || `${req.headers.origin}/?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancel_url || `${req.headers.origin}/?purchase=cancelled`,
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('create-checkout-session error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// ══════════════════════════════════════════════════════
//  THE FORTRESS CHALLENGE — INVOICING
//
//  Pledges are promises, not payments. Once the official runs are in,
//  this turns each pledge into a real Stripe invoice: the sponsor's
//  rate times the points actually scored, payable in 30 days.
//
//  The amounts and the split are calculated HERE from the database,
//  never from anything the browser sends — and frozen onto the pledge
//  row, so changing a challenge's share later cannot rewrite what a
//  sponsor was billed.
//
//  Only an admin can trigger this. The caller's Supabase token is
//  verified against Supabase itself, then against the app_admins
//  table — a signed-in coach or a stranger with the anon key gets a
//  403, not an invoice run.
// ══════════════════════════════════════════════════════

// Added to every pledge invoice as its own line. The program keeps
// the pledge itself in full.
const PLATFORM_FEE_PCT = 10;

async function requireAdmin(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;

  // Ask Supabase who this token belongs to.
  const who = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${token}`,
    },
  });
  if (!who.ok) return null;

  const user = await who.json();
  if (!user || !user.email) return null;

  const { data, error } = await supabase
    .from('app_admins')
    .select('email')
    .ilike('email', user.email)
    .limit(1);

  if (error || !data || data.length === 0) return null;
  return user.email;
}


// ══════════════════════════════════════════════════════
//  THE PADRINO'S EMAIL
//
//  One email per pledge, in the language they pledged in. It states
//  the score, the arithmetic and the two amounts separately — the
//  pledge is the program's, the fee is ours — and then one button.
//
//  The button goes to our own page rather than to Stripe, so the
//  address still means something after the pledge is paid or closed.
// ══════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════
//  THE THANK-YOU
//
//  Sent when a pledge is paid. It names the participant and the score
//  one last time, because that is what the padrino actually backed —
//  and it says plainly where the money went, which a bank statement
//  reading "Gostar Digital" does not.
// ══════════════════════════════════════════════════════
async function sendThankYou(pledgeId) {
  const { data: p } = await supabase
    .from('pledges')
    .select('*, players(name), challenges(name, campaigns(name))')
    .eq('id', pledgeId)
    .single();

  if (!p || !p.sponsor_email) return;

  const money = (n) => '$' + Number(n || 0).toFixed(2);
  const who = (p.players && p.players.name)
    || (p.challenges && p.challenges.campaigns && p.challenges.campaigns.name)
    || 'your program';
  const program = (p.challenges && p.challenges.campaigns && p.challenges.campaigns.name) || 'the program';
  const points = p.points_at_invoice || 0;
  const lang = p.lang === 'es' ? 'es' : 'en';

  const t = lang === 'es' ? {
    subject: `Gracias por apoyar a ${who}`,
    hi: `Hola ${p.sponsor_name},`,
    big: `Gracias por apoyar a <strong>${who}</strong>.`,
    body: `Anotó <strong>${points} puntos</strong>, y tu promesa de <strong>${money(p.team_amount)}</strong> va camino a ${program}.`,
    nothing: `No se debe nada más.`,
    sign: `— Cada Punto`,
  } : {
    subject: `Thank you for backing ${who}`,
    hi: `Hi ${p.sponsor_name},`,
    big: `Thank you for backing <strong>${who}</strong>.`,
    body: `They scored <strong>${points} points</strong>, and your pledge of <strong>${money(p.team_amount)}</strong> is on its way to ${program}.`,
    nothing: `Nothing further is owed.`,
    sign: `— Cada Punto`,
  };

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;color:#111;">
      <p>${t.hi}</p>
      <p style="font-size:18px;">${t.big}</p>
      <p>${t.body}</p>
      <p style="color:#666;font-size:14px;">${t.nothing}</p>
      <p style="color:#666;font-size:14px;">${t.sign}</p>
    </div>`;

  const text = `${t.hi}\n\n${t.big.replace(/<[^>]+>/g, '')}\n` +
               `${t.body.replace(/<[^>]+>/g, '')}\n\n${t.nothing}\n${t.sign}\n`;

  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [p.sponsor_email],
      ...(MAIL_REPLY_TO ? { reply_to: MAIL_REPLY_TO } : {}),
      subject: t.subject, html, text,
    }),
  });

  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Resend refused the thank-you (${r.status}): ${detail.slice(0, 300)}`);
  }
}


async function sendPledgeEmail(o) {
  const money = (n) => '$' + Number(n).toFixed(2);

  const t = o.lang === 'es' ? {
    subjectNew: `${o.who} anotó ${o.points} puntos`,
    subject1: `Recordatorio — la promesa que hiciste por ${o.who}`,
    subject2: `Última llamada — la promesa por ${o.who}`,
    hi: `Hola ${o.name},`,
    scored: `<strong>${o.who}</strong> anotó <strong>${o.points} puntos</strong>.`,
    pledged: `Prometiste ${money(o.rate)} por punto, así que tu promesa es de <strong>${money(o.pledged)}</strong>.`,
    feeLine: `Cargo de plataforma (10%)`,
    totalLine: `Total a pagar`,
    pay: `Pagar ${money(o.amount)}`,
    goes: `Los ${money(o.pledged)} de tu promesa van completos a ${o.teamName}.`,
    window: `El enlace queda abierto treinta días.`,
    nudge1: `Todavía no hemos recibido tu pago — aquí está el enlace otra vez, por si se te perdió.`,
    nudge2: `Este es el último recordatorio. Después de treinta días la promesa se cierra y no se debe nada.`,
    thanks: `Gracias por apoyarlo.`,
  } : {
    subjectNew: `${o.who} scored ${o.points} points`,
    subject1: `A reminder about your pledge for ${o.who}`,
    subject2: `Last call — your pledge for ${o.who}`,
    hi: `Hi ${o.name},`,
    scored: `<strong>${o.who}</strong> scored <strong>${o.points} points</strong>.`,
    pledged: `You pledged ${money(o.rate)} a point, so your pledge comes to <strong>${money(o.pledged)}</strong>.`,
    feeLine: `Platform fee (10%)`,
    totalLine: `Total to pay`,
    pay: `Pay ${money(o.amount)}`,
    goes: `The ${money(o.pledged)} you pledged goes to ${o.teamName} in full.`,
    window: `The link stays open for thirty days.`,
    nudge1: `We have not seen your payment yet — here is the link again, in case it got buried.`,
    nudge2: `This is the last reminder. After thirty days the pledge closes and nothing is owed.`,
    thanks: `Thank you for backing them.`,
  };

  const subject = o.reminder === 2 ? t.subject2
                : o.reminder === 1 ? t.subject1
                : t.subjectNew;

  const nudge = o.reminder === 2 ? t.nudge2
              : o.reminder === 1 ? t.nudge1
              : '';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;color:#111;">
      <p>${t.hi}</p>
      ${nudge ? `<p style="color:#555;">${nudge}</p>` : ''}
      <p style="font-size:17px;">${t.scored}</p>
      <p>${t.pledged}</p>

      <table style="border-collapse:collapse;font-size:14px;margin:18px 0;">
        <tr><td style="padding:6px 18px 6px 0;color:#666;">${t.feeLine}</td>
            <td style="padding:6px 0;">${money(o.platformAmount)}</td></tr>
        <tr><td style="padding:6px 18px 6px 0;border-top:1px solid #ddd;"><strong>${t.totalLine}</strong></td>
            <td style="padding:6px 0;border-top:1px solid #ddd;"><strong>${money(o.amount)}</strong></td></tr>
      </table>

      <p style="margin:22px 0;">
        <a href="${o.payUrl}"
           style="display:inline-block;padding:14px 28px;background:#22D3EE;color:#04121A;
                  text-decoration:none;border-radius:10px;font-weight:bold;font-size:16px;">
          ${t.pay}
        </a>
      </p>

      <p style="color:#555;font-size:14px;">${t.goes}</p>
      <p style="color:#888;font-size:13px;">${t.window}</p>
      <p style="color:#555;">${t.thanks}</p>
    </div>`;

  const text =
    `${t.hi}\n\n${nudge ? nudge + '\n\n' : ''}` +
    `${o.who} scored ${o.points} points.\n` +
    `Your pledge: ${money(o.pledged)}\n` +
    `Platform fee (10%): ${money(o.platformAmount)}\n` +
    `Total: ${money(o.amount)}\n\n` +
    `Pay here: ${o.payUrl}\n`;

  // A send that does not happen must not be reported as one. Without
  // this the endpoint counts a link as sent while the padrino never
  // hears from us.
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not set on this server');
  }

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [o.to],
      ...(MAIL_REPLY_TO ? { reply_to: MAIL_REPLY_TO } : {}),
      subject, html, text,
    }),
  });

  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Resend refused the email (${r.status}): ${detail.slice(0, 300)}`);
  }
}

app.post('/challenge-invoices', async (req, res) => {
  const admin = await requireAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Not authorized' });

  const { challenge_id } = req.body;
  if (!challenge_id) return res.status(400).json({ error: 'challenge_id is required' });

  try {
    const { data: challenge, error: chErr } = await supabase
      .from('challenges')
      .select('id, name, team_share_pct, campaign_id, campaigns(name)')
      .eq('id', challenge_id)
      .single();

    if (chErr || !challenge) return res.status(404).json({ error: 'Challenge not found' });

    const { data: runs } = await supabase
      .from('challenge_runs')
      .select('player_id, points')
      .eq('challenge_id', challenge_id);

    const pointsByPlayer = {};
    let teamPoints = 0;
    (runs || []).forEach(r => {
      pointsByPlayer[r.player_id] = r.points || 0;
      teamPoints += r.points || 0;
    });

    const { data: pledges } = await supabase
      .from('pledges')
      .select('*, players(name)')
      .eq('challenge_id', challenge_id);

    const teamName = (challenge.campaigns && challenge.campaigns.name) || 'the program';
    const payBase = BASKETBALL_GAMES.indexOf(challenge.game) !== -1
      ? PAY_BASE.basketball : PAY_BASE.school;
    const results = { sent: 0, skipped: 0, zero: 0, failed: 0, errors: [] };

    for (const p of pledges || []) {
      // A link already sent is never sent again — a padrino should
      // hold exactly one.
      if (p.pay_link_id || p.stripe_invoice_id) { results.skipped++; continue; }

      const points = p.player_id ? (pointsByPlayer[p.player_id] || 0) : teamPoints;

      // No points means nothing owed. The pledge is closed out rather
      // than left looking unfinished.
      if (points <= 0) {
        await supabase.from('pledges')
          .update({ points_at_invoice: 0, amount: 0, team_amount: 0,
                    platform_amount: 0, invoice_status: 'no_points' })
          .eq('id', p.id);
        results.zero++;
        continue;
      }

      // The pledge belongs to the program in full. Our share is added
      // on top as its own line, so a coach can tell a sponsor
      // truthfully that every dollar they pledge reaches the team.
      const pledged = +(Number(p.rate_per_point) * points).toFixed(2);
      const platformAmount = +(pledged * (PLATFORM_FEE_PCT / 100)).toFixed(2);
      const amount = +(pledged + platformAmount).toFixed(2);
      const teamAmount = pledged;
      const cents = Math.round(amount * 100);

      if (cents < 50) {
        // Stripe will not invoice below 50 cents, and chasing 30 cents
        // costs more than it collects.
        await supabase.from('pledges')
          .update({ points_at_invoice: points, amount, team_amount: teamAmount,
                    platform_amount: platformAmount, invoice_status: 'too_small' })
          .eq('id', p.id);
        results.zero++;
        continue;
      }

      const who = p.player_id && p.players ? p.players.name : teamName;
      const lang = (p.lang === 'es') ? 'es' : 'en';

      try {
        // A payment link needs a price object, so one is made for this
        // exact pledge. Nothing is reused between padrinos — each
        // amount is its own.
        const price = await stripe.prices.create({
          currency: 'usd',
          unit_amount: cents,
          product_data: {
            name: lang === 'es'
              ? `${challenge.name} — ${points} puntos de ${who}`
              : `${challenge.name} — ${points} points scored by ${who}`,
          },
        });

        const link = await stripe.paymentLinks.create({
          line_items: [{ price: price.id, quantity: 1 }],
          metadata: { challenge_id, pledge_id: p.id, points: String(points) },
          // One payment and the link is spent — a second tap on the
          // same link would otherwise charge somebody's grandmother
          // twice.
          restrictions: { completed_sessions: { limit: 1 } },
          after_completion: {
            type: 'redirect',
            redirect: { url: `${payBase}/pay.html?p=${p.id}&paid=1` },
          },
        });

        await supabase.from('pledges')
          .update({
            points_at_invoice: points,
            amount,
            team_amount: teamAmount,
            platform_amount: platformAmount,
            pay_link_id: link.id,
            pay_link_url: link.url,
            invoice_status: 'sent',
            invoiced_at: new Date().toISOString(),
          })
          .eq('id', p.id);

        await sendPledgeEmail({
          to: p.sponsor_email,
          name: p.sponsor_name,
          who, points, teamName, lang,
          rate: Number(p.rate_per_point),
          pledged, platformAmount, amount,
          payUrl: `${payBase}/pay.html?p=${p.id}`,
          reminder: 0,
        });

        results.sent++;
      } catch (e) {
        console.error(`Payment link failed for pledge ${p.id}:`, e.message);
        results.failed++;
        results.errors.push(`${p.sponsor_name}: ${e.message}`);
      }
    }

    console.log(`Challenge ${challenge_id} payment links —`, JSON.stringify(results));
    res.json(results);
  } catch (e) {
    console.error('challenge-invoices error:', e);
    res.status(500).json({ error: String(e) });
  }
});


// ══════════════════════════════════════════════════════
//  PROGRAM APPLICATION ALERT
//
//  The sign-up form writes the application to the database itself,
//  then calls this with the row's id. The application is therefore
//  never lost if the email fails.
//
//  The id is looked up before anything is sent, so this endpoint
//  cannot be used to send mail that isn't backed by a real
//  application — posting a made-up id gets a 404, not an email.
// ══════════════════════════════════════════════════════
app.post('/notify-application', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });

  try {
    const { data: a, error } = await supabase
      .from('program_applications')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !a) return res.status(404).json({ error: 'Not found' });

    const line = (label, value) =>
      value ? `<tr><td style="padding:6px 14px 6px 0;color:#888;">${label}</td><td style="padding:6px 0;"><strong>${value}</strong></td></tr>` : '';

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;">
        <p style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#C9601F;margin:0 0 6px;">New program application</p>
        <h2 style="margin:0 0 18px;font-size:22px;">${a.program_name}</h2>
        <table style="font-size:14px;border-collapse:collapse;">
          ${line('Type', a.org_type)}
          ${line('Town', a.town)}
          ${line('Players', a.players)}
          ${line('Raising for', a.raising_for)}
          ${line('Contact', a.contact_name)}
          ${line('Email', a.contact_email)}
          ${line('Phone', a.contact_phone)}
          ${line('Pay to', a.payee_name)}
          ${line('EIN', a.ein)}
          ${line('Notes', a.notes)}
        </table>
        <p style="font-size:13px;color:#888;margin-top:20px;">
          They confirmed this is a non-profit program.
        </p>
      </div>`;

    const text =
      `New program application\n\n${a.program_name}\n` +
      `Type: ${a.org_type}\nTown: ${a.town || '-'}\nPlayers: ${a.players || '-'}\n` +
      `Raising for: ${a.raising_for || '-'}\n\n` +
      `Contact: ${a.contact_name}\nEmail: ${a.contact_email}\nPhone: ${a.contact_phone || '-'}\n\n` +
      `Pay to: ${a.payee_name}\nEIN: ${a.ein || '-'}\nNotes: ${a.notes || '-'}`;

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM,
        to: [process.env.MAIL_REPLY_TO],
        reply_to: a.contact_email,
        subject: `New program: ${a.program_name}`,
        html,
        text,
      }),
    });

    console.log(`Application alert sent for ${a.program_name}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('notify-application error:', e);
    res.status(500).json({ error: String(e) });
  }
});


// ══════════════════════════════════════════════════════
//  REMINDERS
//
//  Invoicing chased people for us. A link does not, so this does —
//  once at seven days, once at twenty-one, and then never again.
//  At thirty days the pledge closes and nothing more is asked.
//
//  Admin presses a button. Automatic scheduling is a later problem;
//  pressing this twice a month is not a burden.
// ══════════════════════════════════════════════════════
app.post('/send-reminders', async (req, res) => {
  const admin = await requireAdmin(req);
  if (!admin.ok) return res.status(admin.code).json({ error: admin.error });

  const { challenge_id } = req.body;
  if (!challenge_id) return res.status(400).json({ error: 'challenge_id is required' });

  try {
    const { data: challenge } = await supabase
      .from('challenges')
      .select('name, campaign_id, campaigns(name)')
      .eq('id', challenge_id)
      .single();

    if (!challenge) return res.status(404).json({ error: 'Challenge not found' });

    const { data: pledges } = await supabase
      .from('pledges')
      .select('*, players(name)')
      .eq('challenge_id', challenge_id)
      .eq('invoice_status', 'sent');

    const teamName = (challenge.campaigns && challenge.campaigns.name) || 'the program';
    const now = Date.now();
    const days = (iso) => (now - new Date(iso).getTime()) / 86400000;

    const results = { sent: 0, notDue: 0, done: 0, failed: 0, errors: [] };

    for (const p of pledges || []) {
      if (!p.invoiced_at || !p.pay_link_url) { results.notDue++; continue; }

      const age = days(p.invoiced_at);
      const count = p.reminder_count || 0;

      // Two reminders, and only when they are actually due.
      let which = 0;
      if (count === 0 && age >= 7 && age < 30) which = 1;
      else if (count === 1 && age >= 21 && age < 30) which = 2;

      if (!which) {
        if (count >= 2 || age >= 30) results.done++;
        else results.notDue++;
        continue;
      }

      try {
        await sendPledgeEmail({
          to: p.sponsor_email,
          name: p.sponsor_name,
          who: p.player_id && p.players ? p.players.name : teamName,
          points: p.points_at_invoice || 0,
          teamName,
          lang: p.lang === 'es' ? 'es' : 'en',
          rate: Number(p.rate_per_point),
          pledged: Number(p.team_amount),
          platformAmount: Number(p.platform_amount),
          amount: Number(p.amount),
          payUrl: p.pay_link_url.includes('pay.html')
            ? p.pay_link_url
            : `${PAY_BASE.school}/pay.html?p=${p.id}`,
          reminder: which,
        });

        await supabase.from('pledges')
          .update({ reminder_count: which, reminded_at: new Date().toISOString() })
          .eq('id', p.id);

        results.sent++;
      } catch (e) {
        console.error(`Reminder failed for pledge ${p.id}:`, e.message);
        results.failed++;
        results.errors.push(`${p.sponsor_name}: ${e.message}`);
      }
    }

    console.log(`Challenge ${challenge_id} reminders —`, JSON.stringify(results));
    res.json(results);
  } catch (e) {
    console.error('send-reminders error:', e);
    res.status(500).json({ error: String(e) });
  }
});

app.get('/', (req, res) => res.send('Basketball Money payment server is running.'));

// Sends the card link by email through Resend's HTTP API. No extra
// npm package needed — Node 18+ has fetch built in.
async function sendCardEmail({ to, buyerName, tokens, merchantName, offerText, validWhen, tabCount, playerName, expiresOn, kind, redeemUrl }) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');

  const list = Array.isArray(tokens) ? tokens : [tokens];
  const many = list.length > 1;
  const linkFor = (tk) => `${CARD_BASE_URL}/?card=${tk}`;
  const supporting = playerName ? ` supporting ${playerName}` : '';

  const isLicense = kind === 'license';

  const cardBlocks = isLicense ? list.map((tk, i) => `
    <div style="border:1px solid #e3e3e3;border-radius:12px;padding:18px;margin-bottom:14px;">
      ${many ? `<p style="margin:0 0 8px;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.5px;">Access ${i + 1} of ${list.length}</p>` : ''}
      <p style="margin:0 0 4px;font-size:13px;color:#666;">One year of access</p>
      <p style="margin:0;font-size:13px;color:#666;">Your access code</p>
      <p style="margin:2px 0 14px;font-family:monospace;font-size:22px;font-weight:700;letter-spacing:2px;">${tk}</p>
      ${redeemUrl ? `<a href="${redeemUrl}" style="display:inline-block;background:#5b2377;color:#fff;text-decoration:none;padding:11px 22px;border-radius:9px;font-weight:700;font-size:14px;">Open ${merchantName}</a>
      <p style="margin:12px 0 0;font-size:11px;word-break:break-all;color:#5b2377;">${redeemUrl}</p>` : ''}
    </div>`).join('') : list.map((tk, i) => `
    <div style="border:1px solid #e3e3e3;border-radius:12px;padding:18px;margin-bottom:14px;">
      ${many ? `<p style="margin:0 0 8px;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.5px;">Card ${i + 1} of ${list.length}</p>` : ''}
      <p style="margin:0 0 4px;font-size:13px;color:#666;">${tabCount} coupon tabs</p>
      <p style="margin:0 0 4px;font-size:17px;font-weight:700;">${offerText}</p>
      ${validWhen ? `<p style="margin:0 0 12px;font-size:13px;color:#8a5a00;font-weight:600;">${validWhen}</p>` : '<div style="height:8px"></div>'}
      <p style="margin:0;font-size:13px;color:#666;">Card code</p>
      <p style="margin:2px 0 14px;font-family:monospace;font-size:20px;font-weight:700;letter-spacing:1px;">${tk}</p>
      <a href="${linkFor(tk)}" style="display:inline-block;background:#5b2377;color:#fff;text-decoration:none;padding:11px 22px;border-radius:9px;font-weight:700;font-size:14px;">Open this card</a>
      <p style="margin:12px 0 0;font-size:11px;word-break:break-all;color:#5b2377;">${linkFor(tk)}</p>
    </div>`).join('');

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1a1a1a;">
    <h1 style="font-size:22px;margin:0 0 6px;">${many ? `Your ${list.length} ${merchantName} cards are ready` : `Your ${merchantName} card is ready`}</h1>
    <p style="margin:0 0 18px;color:#666;font-size:14px;">Thanks${buyerName ? ', ' + buyerName : ''} — your purchase${supporting} is confirmed.</p>

    ${cardBlocks}

    <p style="margin:22px 0 0;font-size:12px;color:#888;line-height:1.5;">
      ${expiresOn ? `Valid through ${expiresOn}. ` : ''}${isLicense
        ? `Save this email — ${many ? 'these codes are' : 'this code is'} how you get in.${many ? ' Each code is separate, so you can pass one on.' : ''}`
        : `Save this email — ${many ? 'these links are' : 'this link is'} how you open your ${many ? 'cards' : 'card'}.${many ? ' Each card is separate, so you can forward a link to whoever you are giving it to.' : ''}
      At the register, tap a coupon to peel it, then hand your phone to the cashier.`}
    </p>
  </div>`;

  const text = `${many ? `Your ${list.length} ${merchantName} cards are ready.` : `Your ${merchantName} card is ready.`}

${list.map((tk, i) => `${many ? `Card ${i + 1} of ${list.length}\n` : ''}Code: ${tk}
${tabCount} coupon tabs — ${offerText}${validWhen ? ' (' + validWhen + ')' : ''}
Open: ${linkFor(tk)}`).join('\n\n')}

${expiresOn ? `Valid through ${expiresOn}.\n` : ''}Save this email.${many ? ' Each card is separate — forward a link to whoever you are giving it to.' : ''} At the register, tap a coupon to peel it, then hand your phone to the cashier.`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      ...(MAIL_REPLY_TO ? { reply_to: MAIL_REPLY_TO } : {}),
      to: [to],
      subject: many
        ? `Your ${list.length} ${merchantName} BOGO cards are ready`
        : `Your ${merchantName} BOGO card — code ${list[0]}`,
      html,
      text,
    }),
  });

  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${await res.text()}`);
  }
}

function randToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Payment server listening on ${port}`));
