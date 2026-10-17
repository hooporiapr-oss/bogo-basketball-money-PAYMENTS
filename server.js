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

    // Una promesa por juego se marca pagada aquí. El reparto ya se
    // calculó cuando se cerró el juego, así que sólo hace falta
    // anotar que entró.
    const gamePledgeId = session.metadata && session.metadata.game_pledge_id;
    if (gamePledgeId) {
      try {
        // Nada que hacer si ya estaba pagada: Stripe reintenta, y el
        // padrino no debe recibir dos gracias.
        const { data: existing, error: exErr } = await supabase
          .from('game_pledges')
          .select('*')
          .eq('id', gamePledgeId)
          .single();

        if (exErr) console.error('Game pledge lookup:', exErr.message);

        if (existing && existing.invoice_status === 'paid') {
          return res.json({ received: true });
        }

        await supabase.from('game_pledges')
          .update({ invoice_status: 'paid', paid_at: new Date().toISOString() })
          .eq('id', gamePledgeId);
        console.log(`Game pledge ${gamePledgeId} paid`);

        if (existing) {
          try {
            const { data: gm } = await supabase
              .from('games').select('opponent, home')
              .eq('id', existing.game_id).single();
            const { data: cp } = await supabase
              .from('campaigns').select('name')
              .eq('id', existing.campaign_id).single();

            await sendGameThanks({
              to: existing.padrino_email,
              name: existing.padrino_name,
              teamName: (cp && cp.name) || 'the program',
              label: gm ? `${gm.home ? 'vs' : '@'} ${gm.opponent}` : '',
              points: existing.points || 0,
              pledged: Number(existing.team_amount || 0),
              amount: Number(existing.amount || 0),
            });
            console.log(`Thanks sent to ${existing.padrino_email}`);
          } catch (e) {
            // Un gracias que no sale no debe romper el cobro.
            console.error('Game thanks:', e.message);
          }
        } else {
          console.error(`Game pledge ${gamePledgeId}: no row, no thanks sent`);
        }
      } catch (e) {
        console.error('Game pledge webhook:', e.message);
      }
      return res.json({ received: true });
    }

    const pledgeId = session.metadata && session.metadata.pledge_id;

    if (pledgeId) {
      try {
        // What they actually paid, which may not be what was billed:
        // the pay page lets a padrino round up or pay less. The
        // program's share and our fee follow the real figure, keeping
        // the fee on top rather than out of the pledge.
        const paidCents = (session && (session.amount_total ?? session.amount_subtotal)) || 0;
        const patch = { invoice_status: 'paid', paid_at: new Date().toISOString() };

        if (paidCents > 0) {
          const paid = paidCents / 100;
          const team = Math.round((paid / 1.10) * 100) / 100;
          patch.amount = paid;
          patch.team_amount = team;
          patch.platform_amount = Math.round((paid - team) * 100) / 100;
        }

        await supabase
          .from('pledges')
          .update(patch)
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
// El cargo de plataforma. Se suma encima del pago del padrino: el
// programa recibe completo lo que recaudó, pase lo que pase aquí.
const PLATFORM_FEE_PCT = 20;

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
    pledged: o.cap
      ? `Prometiste ${money(o.rate)} por punto, que serían ${money(o.bruto)} — pero pusiste un tope de ${money(o.cap)}, así que tu promesa es de <strong>${money(o.pledged)}</strong>.`
      : `Prometiste ${money(o.rate)} por punto, así que tu promesa es de <strong>${money(o.pledged)}</strong>.`,
    feeLine: `Cargo de plataforma (${PLATFORM_FEE_PCT}%)`,
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
    pledged: o.cap
      ? `You pledged ${money(o.rate)} a point, which would have come to ${money(o.bruto)} — but you set a ${money(o.cap)} cap, so your pledge is <strong>${money(o.pledged)}</strong>.`
      : `You pledged ${money(o.rate)} a point, so your pledge comes to <strong>${money(o.pledged)}</strong>.`,
    feeLine: `Platform fee (${PLATFORM_FEE_PCT}%)`,
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

  // La versión en texto se saca del MISMO t que el html, sin las
  // etiquetas. Escrita aparte se quedaba en inglés aunque el padrino
  // hubiera prometido en español, y no contaba lo que habría sido sin
  // tope — o sea, decía "$5.00 (capped at $5.00)" y nada más. Quien lee
  // el correo en texto plano merece la misma cuenta.
  const sinTags = (h) => String(h).replace(/<[^>]+>/g, '');

  const text =
    `${t.hi}\n\n${nudge ? nudge + '\n\n' : ''}` +
    `${sinTags(t.scored)}\n` +
    `${sinTags(t.pledged)}\n\n` +
    `${t.feeLine}: ${money(o.platformAmount)}\n` +
    `${t.totalLine}: ${money(o.amount)}\n\n` +
    `${o.payUrl}\n\n` +
    `${sinTags(t.goes)}\n${t.window}\n`;

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


// ══════════════════════════════════════════════════════
//  PAY WHAT YOU DECIDE
//
//  A padrino pledged per point, but the person in front of the bill
//  may want to round up, or may be having a hard month. This makes a
//  checkout for whatever they choose rather than only the exact
//  figure — the pledge is a promise, not a debt collector.
// ══════════════════════════════════════════════════════
app.post('/pay-pledge', async (req, res) => {
  try {
    const { pledge_id, amount } = req.body;
    if (!pledge_id) return res.status(400).json({ error: 'pledge_id is required' });

    const cents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(cents) || cents < 100) {
      return res.status(400).json({ error: 'Amount must be at least $1.00' });
    }
    if (cents > 500000) {
      return res.status(400).json({ error: 'Amount is too large' });
    }

    const { data: p } = await supabase
      .from('pledges')
      .select('*, players(name), challenges(name, campaigns(name))')
      .eq('id', pledge_id)
      .single();

    if (!p) return res.status(404).json({ error: 'Pledge not found' });
    if (p.invoice_status === 'paid') {
      return res.status(400).json({ error: 'This pledge has already been paid' });
    }

    const who = (p.players && p.players.name) || 'the program';
    const program = (p.challenges && p.challenges.campaigns && p.challenges.campaigns.name) || 'the program';
    const base = PAY_BASE.school;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Backing ${who}`,
            description: `${program} · ${p.points_at_invoice || 0} points`,
          },
          unit_amount: cents,
        },
        quantity: 1,
      }],
      metadata: {
        pledge_id: String(pledge_id),
        chosen_amount: String(cents),
      },
      ...(p.sponsor_email ? { customer_email: p.sponsor_email } : {}),
      success_url: `${base}/pay.html?p=${encodeURIComponent(pledge_id)}&paid=1`,
      cancel_url: `${base}/pay.html?p=${encodeURIComponent(pledge_id)}`,
    });

    return res.json({ url: session.url });
  } catch (e) {
    console.error('Pay pledge:', e);
    return res.status(500).json({ error: e.message });
  }
});


// ══════════════════════════════════════════════════════════════
//  Promesas por juego
//
//  Un juego se cierra con su marcador y entonces cada promesa
//  abierta se puede cobrar. Esto manda un enlace de pago por
//  correo, uno por promesa, igual que con los retos.
// ══════════════════════════════════════════════════════════════

// El gracias después de pagar. Corto, y dice a dónde fue el dinero.
async function sendGameThanks(o) {
  const money = (n) => '$' + Number(n).toFixed(2);

  const subject = `Thank you — ${o.teamName}`;

  const html = `
    <div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#12202E">
      <p style="font-size:.75rem;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#5A6B7C;margin:0 0 6px">
        Cada Punto Cuenta
      </p>
      <h1 style="font-size:1.6rem;margin:0 0 14px">Thank you, ${o.name}.</h1>

      <p style="margin:0 0 4px">${o.teamName} ${o.label}</p>
      <p style="margin:0 0 18px;color:#5A6B7C"><b style="color:#12202E;font-size:1.2rem">${o.points}</b> points scored</p>

      <div style="border:2px solid #12202E;border-radius:4px;padding:16px;text-align:center;margin:0 0 18px">
        <div style="font-size:2rem;font-weight:900;line-height:1">${money(o.pledged)}</div>
        <div style="font-size:.64rem;font-weight:900;letter-spacing:.2em;text-transform:uppercase;color:#5A6B7C;margin-top:4px">
          goes to the program
        </div>
      </div>

      <p style="color:#5A6B7C;font-size:.92rem">
        You paid ${money(o.amount)}. Every dollar of your pledge reaches ${o.teamName} —
        our platform fee was added on top, never taken out of it.
      </p>

      <p style="color:#5A6B7C;font-size:.82rem;margin-top:22px">
        Gostar Digital LLC · Puerto Rico
      </p>
    </div>`;

  const text =
    `Thank you, ${o.name}.\n\n` +
    `${o.teamName} ${o.label} — ${o.points} points\n\n` +
    `${money(o.pledged)} goes to the program.\n` +
    `You paid ${money(o.amount)}; our fee was added on top.\n\n` +
    `Gostar Digital LLC · Puerto Rico\n`;

  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');

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
    throw new Error(`Resend refused the thanks (${r.status}): ${detail.slice(0, 300)}`);
  }
}


// ══════════════════════════════════════════════════════════════
//  Aviso de un equipo que se inscribe
//
//  La petición ya quedó guardada antes de llegar aquí; esto sólo
//  avisa, para no tener que estar mirando el admin. Si el correo
//  falla, la petición sigue ahí.
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
//  Aviso: un coach puso un marcador
//
//  Un equipo en Florida pone su marcador a las once de la noche
//  y las promesas quedan listas para cobrar. Sin este aviso hay
//  que estar mirando el admin por si acaso.
// ══════════════════════════════════════════════════════════════
app.post('/score-posted', async (req, res) => {
  const { game_id } = req.body || {};
  if (!game_id) return res.status(400).json({ error: 'game_id is required' });

  try {
    const { data: game } = await supabase
      .from('games')
      .select('id, campaign_id, opponent, plays_on, home, team_points, opp_points, note')
      .eq('id', game_id)
      .single();

    if (!game) return res.json({ ok: false, note: 'no game' });

    const { data: pledges } = await supabase
      .from('game_pledges')
      .select('team_amount, invoice_status')
      .eq('game_id', game_id);

    const open = (pledges || []).filter(p => p.invoice_status === 'open');

    // Sin promesas no hay nada que hacer, así que no se avisa: un
    // correo por cada juego de cada equipo sería ruido.
    if (!open.length) return res.json({ ok: true, notified: false });

    const due = open.reduce((n, p) => n + Number(p.team_amount || 0), 0);

    const { data: camp } = await supabase
      .from('campaigns').select('name').eq('id', game.campaign_id).single();

    const team = (camp && camp.name) || 'A program';
    const label = `${game.home ? 'vs' : '@'} ${game.opponent}`;
    const to = process.env.ADMIN_EMAIL || 'gostardigital@gmail.com';

    const html = `
      <div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#12202E">
        <p style="font-size:.72rem;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#0B7A5A;margin:0 0 6px">
          Listo para cobrar
        </p>
        <h1 style="font-size:1.35rem;margin:0 0 4px">${team} ${label}</h1>
        <p style="margin:0 0 16px;color:#5A6B7C">
          ${game.plays_on || ''} · Final <b style="color:#12202E">${game.team_points}</b>${
            game.opp_points != null ? ` – ${game.opp_points}` : ''}
        </p>

        <table style="width:100%;border-collapse:collapse;font-size:.95rem">
          <tr><td style="padding:7px 0;border-bottom:1px solid #D7E0E8">Promesas sin cobrar</td>
              <td style="padding:7px 0;border-bottom:1px solid #D7E0E8;text-align:right"><b>${open.length}</b></td></tr>
          <tr><td style="padding:7px 0">Para el programa</td>
              <td style="padding:7px 0;text-align:right"><b>$${due.toFixed(2)}</b></td></tr>
        </table>

        <p style="margin:18px 0 0;color:#5A6B7C;font-size:.9rem">
          Manda los enlaces de pago desde el admin.
        </p>
        <p style="color:#5A6B7C;font-size:.8rem;margin-top:20px">
          Gostar Digital LLC · Puerto Rico
        </p>
      </div>`;

    const text =
      `${team} ${label} — ${game.plays_on || ''}\n` +
      `Final: ${game.team_points}${game.opp_points != null ? ' – ' + game.opp_points : ''}\n\n` +
      `${open.length} promesa(s) sin cobrar · $${due.toFixed(2)} para el programa.\n` +
      `Manda los enlaces de pago desde el admin.\n`;

    if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [to],
        ...(MAIL_REPLY_TO ? { reply_to: MAIL_REPLY_TO } : {}),
        subject: `Listo para cobrar: ${team} ${label}`,
        html, text,
      }),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      throw new Error(`Resend refused the notice (${r.status}): ${detail.slice(0, 200)}`);
    }

    return res.json({ ok: true, notified: true, pledges: open.length });
  } catch (e) {
    // El aviso es un extra: que falle no puede romper nada.
    console.error('Score notice:', e.message);
    return res.json({ ok: false, note: 'notice failed' });
  }
});

app.post('/team-signup', async (req, res) => {
  const { team, program, coach, email, phone } = req.body || {};

  if (!team || !email) {
    return res.status(400).json({ error: 'team and email are required' });
  }

  const to = process.env.ADMIN_EMAIL || 'gostardigital@gmail.com';

  const row = (k, v) =>
    `<tr><td style="padding:6px 14px 6px 0;color:#5A6B7C">${k}</td>` +
    `<td style="padding:6px 0;font-weight:700">${v || '—'}</td></tr>`;

  const html = `
    <div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#12202E">
      <p style="font-size:.72rem;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#0C6E8C;margin:0 0 6px">
        Cada Punto
      </p>
      <h1 style="font-size:1.4rem;margin:0 0 14px">${team} quiere una campaña</h1>
      <table style="width:100%;border-collapse:collapse;font-size:.95rem">
        ${row('Equipo', team)}
        ${row('Programa', program)}
        ${row('Coach', coach)}
        ${row('Correo', `<a href="mailto:${email}">${email}</a>`)}
        ${row('Teléfono', phone)}
      </table>
      <p style="margin:18px 0 0;color:#5A6B7C;font-size:.9rem">
        Aprueba o rechaza desde el admin — la petición ya está en la cola.
      </p>
      <p style="color:#5A6B7C;font-size:.8rem;margin-top:20px">
        Gostar Digital LLC · Puerto Rico
      </p>
    </div>`;

  const text =
    `${team} quiere una campaña\n\n` +
    `Equipo:   ${team}\n` +
    `Programa: ${program || '—'}\n` +
    `Coach:    ${coach || '—'}\n` +
    `Correo:   ${email}\n` +
    `Teléfono: ${phone || '—'}\n\n` +
    `Aprueba desde el admin.\n`;

  try {
    if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [to],
        reply_to: email,          // contestar le escribe al coach
        subject: `Nuevo equipo: ${team}`,
        html, text,
      }),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      throw new Error(`Resend refused the notice (${r.status}): ${detail.slice(0, 200)}`);
    }

    return res.json({ ok: true });
  } catch (e) {
    // El aviso es un extra: que falle no puede romper la inscripción.
    console.error('Team signup notice:', e.message);
    return res.json({ ok: false, note: 'request saved, notice failed' });
  }
});

app.post('/game-invoices', async (req, res) => {
  const admin = await requireAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Not authorized' });

  const { game_id } = req.body;
  if (!game_id) return res.status(400).json({ error: 'game_id is required' });

  try {
    const { data: game, error: gErr } = await supabase
      .from('games')
      .select('id, opponent, plays_on, home, team_points, status, campaign_id, campaigns(name)')
      .eq('id', game_id)
      .single();

    if (gErr || !game) return res.status(404).json({ error: 'Game not found' });
    if (game.status !== 'played') {
      return res.status(400).json({ error: 'Enter the score first' });
    }

    const points = Number(game.team_points || 0);
    const teamName = (game.campaigns && game.campaigns.name) || 'the program';
    const label = `${game.home ? 'vs' : '@'} ${game.opponent}`;

    const { data: pledges } = await supabase
      .from('game_pledges')
      .select('*')
      .eq('game_id', game_id);

    const results = { sent: 0, skipped: 0, zero: 0, failed: 0, errors: [] };

    for (const p of pledges || []) {
      if (p.invoice_status !== 'open') { results.skipped++; continue; }

      // Sin puntos no hay nada que cobrar. Se cierra la promesa en vez
      // de dejarla pendiente para siempre.
      if (points <= 0) {
        await supabase.from('game_pledges')
          .update({ points: 0, amount: 0, team_amount: 0,
                    platform_amount: 0, invoice_status: 'void' })
          .eq('id', p.id);
        results.zero++;
        continue;
      }

      // El tope lo pone el padrino: nunca paga más de lo que dijo.
      const raw = Number(p.rate) * points;
      const pledged = +(p.cap != null ? Math.min(raw, Number(p.cap)) : raw).toFixed(2);
      const platformAmount = +(pledged * (PLATFORM_FEE_PCT / 100)).toFixed(2);
      const amount = +(pledged + platformAmount).toFixed(2);
      const cents = Math.round(amount * 100);

      if (cents < 50) {
        await supabase.from('game_pledges')
          .update({ points, amount, team_amount: pledged,
                    platform_amount: platformAmount, invoice_status: 'void' })
          .eq('id', p.id);
        results.zero++;
        continue;
      }

      try {
        const price = await stripe.prices.create({
          currency: 'usd',
          unit_amount: cents,
          product_data: { name: `${teamName} ${label} — ${points} points` },
        });

        const link = await stripe.paymentLinks.create({
          line_items: [{ price: price.id, quantity: 1 }],
          metadata: { game_pledge_id: p.id, game_id, points: String(points) },
          restrictions: { completed_sessions: { limit: 1 } },
          after_completion: {
            type: 'redirect',
            redirect: { url: `${PAY_BASE.school}/pay.html?g=${p.id}&paid=1` },
          },
        });

        // El enlace se guarda enseguida: ya existe en Stripe y se
        // perdería si el correo falla.
        await supabase.from('game_pledges')
          .update({
            points,
            amount,
            team_amount: pledged,
            platform_amount: platformAmount,
            stripe_session: link.url,
          })
          .eq('id', p.id);

        await sendGameEmail({
          to: p.padrino_email,
          name: p.padrino_name,
          teamName, label, points,
          rate: Number(p.rate),
          pledged, platformAmount, amount,
          payUrl: link.url,
        });

        // Sólo cuando el correo salió de verdad.
        await supabase.from('game_pledges')
          .update({ invoice_status: 'sent' })
          .eq('id', p.id);

        results.sent++;
      } catch (e) {
        console.error(`Game pledge ${p.id}:`, e.message);
        results.failed++;
        results.errors.push(`${p.padrino_name}: ${e.message}`);
      }
    }

    return res.json(results);
  } catch (e) {
    console.error('Game invoices:', e);
    return res.status(500).json({ error: e.message });
  }
});

// El correo que recibe el padrino después del juego.
async function sendGameEmail(o) {
  const money = (n) => '$' + Number(n).toFixed(2);

  const subject = `${o.teamName} ${o.label} — ${o.points} points`;

  // Esto es una cuenta, no un anuncio, y tiene que parecerlo. Gmail
  // lee un botón grande de color, un wordmark en mayúsculas y una
  // tabla con bordes como lo que son — la silueta de una plantilla de
  // mercadeo — y lo manda a Promociones. Una cuenta en Promociones no
  // se paga: el padrino no la ve, el programa cree que no quiso pagar,
  // y el que termina persiguiendo a la gente eres tú.
  //
  // Así que: sin wordmark, sin botón de bloque, sin tabla. Una carta,
  // con el enlace dentro del texto. Es lo que manda un banco cuando te
  // cobra, y por eso llega.
  const html = `
    <div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#12202E;font-size:15px;line-height:1.6">
      <p>Hi ${o.name},</p>

      <p>${o.teamName} played ${o.label} and scored <b>${o.points} points</b>.
         You pledged ${money(o.rate)} a point, so your pledge comes to
         <b>${money(o.pledged)}</b>.</p>

      <p>With the ${PLATFORM_FEE_PCT}% platform fee of ${money(o.platformAmount)} added on top,
         the total is <b>${money(o.amount)}</b>.
         ${o.teamName} receives your full ${money(o.pledged)} — the fee is added on top of
         your pledge, never taken out of it.</p>

      <p><a href="${o.payUrl}" style="color:#A84200;font-weight:bold">Pay ${money(o.amount)}</a></p>

      <p style="color:#5A6B7C;font-size:13px;margin-top:22px">
        Gostar Digital LLC · Puerto Rico
      </p>
    </div>`;

  const text =
    `${o.teamName} ${o.label} — ${o.points} points\n\n` +
    `Hi ${o.name},\n\n` +
    `You pledged ${money(o.rate)} a point.\n` +
    `Your pledge: ${money(o.pledged)}\n` +
    `Platform fee (${PLATFORM_FEE_PCT}%): ${money(o.platformAmount)}\n` +
    `Total: ${money(o.amount)}\n\n` +
    `Pay here: ${o.payUrl}\n\n` +
    `The program receives your full ${money(o.pledged)}.\n` +
    `Gostar Digital LLC · Puerto Rico\n`;

  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');

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
    throw new Error(`Resend refused the invoice (${r.status}): ${detail.slice(0, 300)}`);
  }
}

// Cobrar un reto: una vez, con los puntos que haya en la base. Está
// aparte de la ruta porque ahora la llaman dos: el admin a mano, y el
// barrido cuando se cierra la ventana.
async function cobrarReto(challenge_id) {
  {
    const { data: challenge, error: chErr } = await supabase
      .from('challenges')
      // `game` decide a qué dominio va el enlace de pago, más abajo.
      // Faltaba en este select, así que llegaba undefined y todo el
      // mundo acababa en cadapunto.com — correcto para la escuela, no
      // para un equipo.
      .select('id, name, game, team_share_pct, campaign_id, campaigns(name)')
      .eq('id', challenge_id)
      .single();

    if (chErr || !challenge) {
      const e = new Error('Challenge not found');
      e.status = 404;
      throw e;
    }

    const { data: runs } = await supabase
      .from('challenge_runs')
      .select('player_id, points')
      .eq('challenge_id', challenge_id);

    const pointsByPlayer = {};
    let teamPoints = 0;
    (runs || []).forEach(r => {
      // three runs per student now, so they add up rather than the
      // last one winning
      pointsByPlayer[r.player_id] = (pointsByPlayer[r.player_id] || 0) + (r.points || 0);
      teamPoints += r.points || 0;
    });

    const { data: pledges } = await supabase
      .from('pledges')
      .select('*, players(name)')
      .eq('challenge_id', challenge_id);

    const teamName = (challenge.campaigns && challenge.campaigns.name) || 'the program';
    const payBase = BASKETBALL_GAMES.indexOf(challenge.game) !== -1
      ? PAY_BASE.basketball : PAY_BASE.school;
    // program/fees se acumulan para el aviso: un correo que dice
    // "4 enlaces" sin decir cuánto no sirve de nada.
    const results = { sent: 0, skipped: 0, zero: 0, failed: 0, program: 0, fees: 0, errors: [] };

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
      //
      // EL TOPE. Un padrino promete por punto sin saber cuánto va a
      // anotar el nene, así que puede poner un techo. Aquí es donde
      // ese techo significa algo: guardado en la fila y no aplicado
      // aquí, sería una promesa que el sistema no cumple.
      //
      // El tope limita LA PROMESA, no el total: el cargo de
      // plataforma se sigue sumando encima, igual que siempre, y es
      // lo que la página del padrino le enseñó antes de prometer.
      const bruto = Number(p.rate_per_point) * points;
      const tope  = (p.cap === null || p.cap === undefined) ? null : Number(p.cap);
      const topado = tope !== null && tope > 0 && bruto > tope;
      const pledged = +(topado ? tope : bruto).toFixed(2);
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
          // Para que el correo no diga una multiplicación que no se
          // hizo: si el tope mordió, lo cuenta.
          cap: topado ? tope : null,
          bruto: topado ? +bruto.toFixed(2) : null,
          payUrl: `${payBase}/pay.html?p=${p.id}`,
          reminder: 0,
        });

        results.sent++;
        results.program = +(results.program + teamAmount).toFixed(2);
        results.fees    = +(results.fees + platformAmount).toFixed(2);
      } catch (e) {
        console.error(`Payment link failed for pledge ${p.id}:`, e.message);
        results.failed++;
        results.errors.push(`${p.sponsor_name}: ${e.message}`);
      }
    }

    console.log(`Challenge ${challenge_id} payment links —`, JSON.stringify(results));
    return results;
  }
}

app.post('/challenge-invoices', async (req, res) => {
  const admin = await requireAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Not authorized' });

  const { challenge_id } = req.body;
  if (!challenge_id) return res.status(400).json({ error: 'challenge_id is required' });

  try {
    res.json(await cobrarReto(challenge_id));
  } catch (e) {
    console.error('challenge-invoices error:', e);
    res.status(e.status || 500).json({ error: String(e.message || e) });
  }
});


// ════════════════════════════════════════════════════
//  EL BARRIDO
//
//  Un día de juego termina cuando se cierra la ventana, y a esa hora
//  no hay nadie sentado delante del admin. Sin esto, las promesas se
//  quedan ahí: el nene jugó, el padrino prometió, y nadie cobra.
//
//  Qué hace que un reto se cobre, y no antes:
//
//    live = true          — lo pusiste en vivo tú
//    closes_at con hora   — le pusiste ventana tú, a mano
//    esa hora ya pasó     — más dos minutos de gracia
//    billed_at vacío      — no se ha cobrado todavía
//
//  Las dos primeras las decides tú al abrir el día de juego. Eso ES
//  la autorización: no hace falta volver a apretar nada.
//
//  Los dos minutos de gracia son por el reloj: la ventana la cierra
//  Postgres con su now(), y este barrido corre en Node. Si el de Node
//  va adelantado, un cuarto que entró con la chicharra podría quedar
//  fuera del cobro. Dos minutos cubren cualquier desfase.
//
//  billed_at se reclama ANTES de cobrar, con un update condicionado a
//  que siga vacío: dos ticks a la vez, o un reinicio en medio, no
//  pueden mandar dos enlaces. Y si algo se cae a mitad, cada promesa
//  ya cobrada tiene su pay_link_id, así que un barrido a mano después
//  manda sólo las que faltan.
//
//  Y manda un correo. Que no haya nadie mirando no quiere decir que
//  nadie se entere.
// ════════════════════════════════════════════════════

const SWEEP_KEY   = process.env.SWEEP_KEY || '';
const SWEEP_EVERY = 5 * 60 * 1000;
const GRACIA      = 2 * 60 * 1000;
let barriendo = false;

async function barrerRetos() {
  if (barriendo) return { busy: true, challenges: 0, detail: [] };
  barriendo = true;

  const hecho = [];
  try {
    const corte = new Date(Date.now() - GRACIA).toISOString();

    const { data: retos, error } = await supabase
      .from('challenges')
      .select('id, name, closes_at, campaign_id, campaigns(name)')
      .eq('live', true)
      .is('billed_at', null)
      .not('closes_at', 'is', null)
      .lt('closes_at', corte);

    if (error) throw error;

    for (const r of retos || []) {
      // La reclamación. Si otro tick llegó primero, este no cobra.
      const { data: mio, error: clErr } = await supabase
        .from('challenges')
        .update({ billed_at: new Date().toISOString() })
        .eq('id', r.id)
        .is('billed_at', null)
        .select('id');

      if (clErr) { console.error(`Barrido ${r.id}:`, clErr.message); continue; }
      if (!mio || !mio.length) continue;

      let out;
      try {
        out = await cobrarReto(r.id);
      } catch (e) {
        console.error(`Barrido ${r.id}:`, e.message);
        out = { sent: 0, skipped: 0, zero: 0, failed: 1, program: 0, fees: 0,
                errors: [String(e.message || e)] };
      }

      hecho.push(Object.assign({ id: r.id, name: r.name }, out));

      // Un aviso que falla no deshace un cobro que ya salió.
      try { await avisoDeBarrido(r, out); }
      catch (e) { console.error('Aviso de barrido:', e.message); }
    }
  } finally {
    barriendo = false;
  }

  if (hecho.length) console.log('Barrido —', JSON.stringify(hecho));
  return { challenges: hecho.length, detail: hecho };
}

async function avisoDeBarrido(reto, out) {
  const to = process.env.ADMIN_EMAIL || 'gostardigital@gmail.com';
  const money = (n) => '$' + Number(n || 0).toFixed(2);
  const equipo = (reto.campaigns && reto.campaigns.name) || '';

  const fila = (k, v) =>
    `<tr><td style="padding:6px 16px 6px 0;color:#5A6B7C">${k}</td>` +
    `<td style="padding:6px 0;font-weight:700">${v}</td></tr>`;

  const html = `
    <div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#12202E;font-size:15px;line-height:1.6">
      <p>Se cerró la ventana de <b>${reto.name || 'un reto'}</b>${equipo ? ' — ' + equipo : ''},
         y los enlaces de pago salieron solos.</p>

      <table style="border-collapse:collapse;font-size:14px;margin:14px 0">
        ${fila('Enlaces mandados', out.sent)}
        ${fila('Para el programa', money(out.program))}
        ${fila('Cargo de plataforma', money(out.fees))}
        ${out.zero ? fila('Sin puntos, cerradas', out.zero) : ''}
        ${out.skipped ? fila('Ya tenían enlace', out.skipped) : ''}
        ${out.failed ? fila('<span style="color:#A84200">Fallaron</span>',
                            `<span style="color:#A84200">${out.failed}</span>`) : ''}
      </table>

      ${out.failed ? `<p style="color:#A84200;font-size:14px">${
          (out.errors || []).map(e => String(e)).join('<br>')
        }</p><p style="font-size:14px">Las que fallaron no tienen enlace, así que
        volver a cobrar el reto manda sólo esas.</p>` : ''}

      <p style="color:#5A6B7C;font-size:13px;margin-top:22px">
        Gostar Digital LLC · Puerto Rico
      </p>
    </div>`;

  const text =
    `Se cerró ${reto.name || 'un reto'}${equipo ? ' — ' + equipo : ''}.\n\n` +
    `Enlaces mandados: ${out.sent}\n` +
    `Para el programa: ${money(out.program)}\n` +
    `Cargo de plataforma: ${money(out.fees)}\n` +
    (out.zero ? `Sin puntos: ${out.zero}\n` : '') +
    (out.failed ? `Fallaron: ${out.failed}\n${(out.errors || []).join('\n')}\n` : '');

  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [to],
      ...(MAIL_REPLY_TO ? { reply_to: MAIL_REPLY_TO } : {}),
      subject: `Cobrado: ${reto.name || 'reto'}${equipo ? ' — ' + equipo : ''}`,
      html, text,
    }),
  });

  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Resend refused the notice (${r.status}): ${detail.slice(0, 200)}`);
  }
}

// Forzar el barrido desde fuera. Dos llaves lo abren: la SWEEP_KEY
// (para un cron de verdad, que no tiene con qué firmar como usuario)
// o el token de un admin.
app.post('/challenge-sweep', async (req, res) => {
  let quien = null;

  const dada = String(req.headers['x-sweep-key'] || '');
  if (SWEEP_KEY && dada.length === SWEEP_KEY.length) {
    // Comparar llaves con === filtra por el primer carácter que
    // difiere. timingSafeEqual tarda lo mismo pase lo que pase.
    try {
      if (crypto.timingSafeEqual(Buffer.from(dada), Buffer.from(SWEEP_KEY))) {
        quien = 'sweep-key';
      }
    } catch (e) { /* longitudes distintas: no es la llave */ }
  }

  if (!quien) quien = await requireAdmin(req);
  if (!quien) return res.status(403).json({ error: 'Not authorized' });

  try {
    const out = await barrerRetos();
    console.log(`Barrido a mano por ${quien} — ${out.challenges} reto(s)`);

    /* Y los recordatorios en la misma llamada. Si este servicio se
       duerme, el reloj de dentro se duerme con él y el único que
       trabaja es el cron de fuera — que no tiene por qué saber que
       aquí dentro hay dos relojes.
       SIN forzar. La guardia de horas no es para proteger al que
       llama: es para que a un padrino no le entre un correo de cobro a
       las tres de la mañana. Un cron que pregunte cada cinco minutos
       es tan rutinario como el reloj de dentro, y si se le deja
       saltar la guardia, la guardia no sirve de nada. Lo único que la
       salta es un humano pidiéndolo a mano en /send-reminders. */
    let rec = null;
    try { rec = await barrerRecordatorios(); }
    catch (e) { console.error('Recordatorios en barrido a mano:', e.message); }

    return res.json(Object.assign({}, out, { reminders: rec }));
  } catch (e) {
    console.error('Barrido:', e);
    return res.status(500).json({ error: String(e.message || e) });
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
//  RECORDATORIOS
//
//  La factura perseguía a la gente por nosotros. Un enlace no, así que
//  esto lo hace — uno a los siete días, uno a los veintiuno, y nunca
//  más. A los treinta días la promesa se cierra y no se pide nada.
//
//  Esto lo decía antes el código: "que lo apriete el admin; ponerle
//  horario es un problema para después". Dejó de serlo el día que la
//  página empezó a prometerle a un programa que los recordatorios
//  salen a los siete y a los veintiún días. Una promesa que depende de
//  que alguien se acuerde de apretar un botón no es una promesa, así
//  que ahora corre solo, con el mismo mecanismo que el cobro.
//
//  DOS COSAS QUE NO SE PUEDEN HACER MAL AQUÍ:
//
//  1. Mandar dos veces. A un padrino que ya recibió "éste es el
//     último recordatorio" no se le puede escribir otra vez: deja de
//     ser verdad lo que le dijimos. Así que el contador se RECLAMA
//     antes de mandar, condicionado a que siga en el número de antes
//     — igual que billed_at en el cobro. Dos ticks a la vez, dos
//     instancias en Render, o un reinicio en medio: sólo uno pasa.
//     Si el correo falla después de reclamar, se devuelve el contador
//     a donde estaba y lo coge el tick siguiente.
//
//  2. Escribir a las tres de la mañana. Un correo de cobro a esa hora
//     asusta. Se manda en horas decentes de Puerto Rico y punto.
// ══════════════════════════════════════════════════════

const RECORDAR_EVERY = 60 * 60 * 1000;   // cada hora; el día manda, no el minuto
const HORA_DESDE = 9;                    // en Puerto Rico
const HORA_HASTA = 20;
let recordando = false;

/* Puerto Rico es UTC-4 todo el año: no hay horario de verano que
   corregir, así que esto no necesita librería. */
function horaPR() {
  return (new Date().getUTCHours() + 24 - 4) % 24;
}
function horaDecente() {
  const h = horaPR();
  return h >= HORA_DESDE && h < HORA_HASTA;
}

async function recordarReto(challenge_id) {
  const { data: challenge } = await supabase
    .from('challenges')
    .select('name, campaign_id, campaigns(name)')
    .eq('id', challenge_id)
    .single();

  if (!challenge) return { error: 'Challenge not found' };

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

    // Dos recordatorios, y sólo cuando de verdad toca.
    let which = 0;
    if (count === 0 && age >= 7 && age < 30) which = 1;
    else if (count === 1 && age >= 21 && age < 30) which = 2;

    if (!which) {
      if (count >= 2 || age >= 30) results.done++;
      else results.notDue++;
      continue;
    }

    // La reclamación, ANTES de mandar. Si otro tick llegó primero, el
    // contador ya no está en `which - 1` y este no manda nada.
    const { data: mio, error: clErr } = await supabase
      .from('pledges')
      .update({ reminder_count: which, reminded_at: new Date().toISOString() })
      .eq('id', p.id)
      .eq('reminder_count', which - 1)
      .select('id');

    if (clErr) {
      console.error(`Reclamar recordatorio ${p.id}:`, clErr.message);
      results.failed++;
      results.errors.push(`${p.sponsor_name}: ${clErr.message}`);
      continue;
    }
    if (!mio || !mio.length) { results.notDue++; continue; }

    try {
      /* El tope, otra vez. El cobro se lo pasa al correo para que no
         diga una multiplicación que no se hizo; el recordatorio no se
         lo pasaba, así que a un padrino con tope le llegaba un
         recordatorio con la cuenta mal. Se saca de lo que de verdad se
         le cobró, no de una cuenta nueva. */
      const bruto  = Number(p.rate_per_point) * (p.points_at_invoice || 0);
      const topado = p.cap != null && Number(p.team_amount) < +bruto.toFixed(2);

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
        cap: topado ? Number(p.cap) : null,
        bruto: topado ? +bruto.toFixed(2) : null,
        payUrl: p.pay_link_url.includes('pay.html')
          ? p.pay_link_url
          : `${PAY_BASE.school}/pay.html?p=${p.id}`,
        reminder: which,
      });

      results.sent++;
    } catch (e) {
      console.error(`Reminder failed for pledge ${p.id}:`, e.message);
      // Se devuelve el contador: mejor que lo reintente el tick
      // siguiente que perder el recordatorio sin que nadie se entere.
      try {
        await supabase.from('pledges')
          .update({ reminder_count: which - 1 })
          .eq('id', p.id)
          .eq('reminder_count', which);
      } catch (e2) { console.error(`Devolver contador ${p.id}:`, e2.message); }
      results.failed++;
      results.errors.push(`${p.sponsor_name}: ${e.message}`);
    }
  }

  return results;
}

/* El barrido de recordatorios. Busca los retos que ya se cobraron y
   todavía tienen promesas sin pagar, y le pasa cada uno a
   recordarReto. El corte de treinta y un días es lo que evita que
   esto crezca para siempre: a los treinta la promesa está cerrada. */
async function barrerRecordatorios(forzado) {
  if (recordando) return { busy: true, challenges: 0, detail: [] };
  if (!forzado && !horaDecente()) {
    return { skipped: 'hora', hora_pr: horaPR(), challenges: 0, detail: [] };
  }
  recordando = true;

  const hecho = [];
  try {
    const desde = new Date(Date.now() - 31 * 86400000).toISOString();

    const { data: filas, error } = await supabase
      .from('pledges')
      .select('challenge_id')
      .eq('invoice_status', 'sent')
      .not('invoiced_at', 'is', null)
      .gte('invoiced_at', desde);

    if (error) throw error;

    const retos = [...new Set((filas || []).map(f => f.challenge_id).filter(Boolean))];

    for (const id of retos) {
      try {
        const out = await recordarReto(id);
        if (out.sent || out.failed) hecho.push(Object.assign({ id }, out));
      } catch (e) {
        console.error(`Barrido de recordatorios ${id}:`, e.message);
        hecho.push({ id, sent: 0, failed: 1, errors: [String(e.message || e)] });
      }
    }
  } finally {
    recordando = false;
  }

  if (hecho.length) {
    console.log('Recordatorios —', JSON.stringify(hecho));
    // Sólo se avisa cuando algo falló. Un correo diario diciendo que
    // todo fue bien se deja de leer a la semana.
    const malos = hecho.filter(h => h.failed);
    if (malos.length) {
      try { await avisoDeRecordatorios(malos); }
      catch (e) { console.error('Aviso de recordatorios:', e.message); }
    }
  }
  return { challenges: hecho.length, detail: hecho };
}

async function avisoDeRecordatorios(malos) {
  const to = process.env.ADMIN_EMAIL || 'gostardigital@gmail.com';
  const n = malos.reduce((a, h) => a + (h.failed || 0), 0);
  const cuerpo =
    `<p>No salieron ${n} recordatorio${n === 1 ? '' : 's'}.</p>` +
    malos.map(h =>
      `<p><b>${h.id}</b><br>` +
      (h.errors || []).map(e => String(e)).join('<br>') + '</p>').join('') +
    `<p>El contador se devolvió, así que el barrido siguiente lo reintenta. ` +
    `Si vuelve a salir este aviso, es que algo está roto de verdad.</p>`;

  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [to],
      ...(MAIL_REPLY_TO ? { reply_to: MAIL_REPLY_TO } : {}),
      subject: `Cada Punto — ${n} recordatorio${n === 1 ? '' : 's'} sin salir`,
      html: cuerpo,
      text: `No salieron ${n} recordatorios. ` +
            malos.map(h => `${h.id}: ${(h.errors || []).join('; ')}`).join(' | '),
    }),
  });

  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Resend refused the notice (${r.status}): ${detail.slice(0, 200)}`);
  }
}

app.post('/send-reminders', async (req, res) => {
  const admin = await requireAdmin(req);
  if (!admin.ok) return res.status(admin.code).json({ error: admin.error });

  const { challenge_id } = req.body;
  if (!challenge_id) return res.status(400).json({ error: 'challenge_id is required' });

  try {
    const results = await recordarReto(challenge_id);
    if (results.error) return res.status(404).json({ error: results.error });

    console.log(`Challenge ${challenge_id} reminders —`, JSON.stringify(results));
    res.json(results);
  } catch (e) {
    console.error('send-reminders error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// ══════════════════════════════════════════════════════════════════
//  POST /coach/chat — la ayuda del entrenador, contestada.
//
//  Dos reglas, y las dos se cumplen aquí dentro y no en el navegador:
//
//  1. Sólo entra quien tiene código. Se comprueba AQUÍ con
//     builder_check. Que la página ya lo haya comprobado no cuenta:
//     cualquiera puede llamar a este endpoint a mano.
//
//  2. Lo de dinero NO lo contesta el modelo. Nunca. Cuándo se paga,
//     el 20%, el tope del padrino, los impuestos — eso sale de DINERO
//     palabra por palabra, el mismo texto que está en ayuda.html. Y si
//     el modelo devuelve una cifra de todas formas, se tira la
//     respuesta entera. Un entrenador que recibe una fecha de pago
//     equivocada de algo que lleva nuestro logo nos cuesta el programa.
// ══════════════════════════════════════════════════════════════════

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Se puede cambiar en Render sin tocar el código.
const COACH_CHAT_MODEL = process.env.COACH_CHAT_MODEL || 'claude-haiku-5-5';

// ── Los topes ───────────────────────────────────────────
// Todos se cambian en Render sin tocar el código. El que de verdad
// protege la factura es el tercero: es el techo del día entero,
// entren los entrenadores que entren.
const topeDe = (v, porDefecto) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : porDefecto;
};
const LIM_HORA  = topeDe(process.env.COACH_CHAT_PER_HOUR, 12);   // por entrenador
const LIM_DIA   = topeDe(process.env.COACH_CHAT_PER_DAY, 30);    // por entrenador
const LIM_TODOS = topeDe(process.env.COACH_CHAT_TOTAL_DAY, 250); // entre todos
// Interruptor de emergencia: COACH_CHAT_OFF=1 y el chat se apaga sin
// tener que quitar la llave ni desplegar nada.
const CHAT_APAGADO = String(process.env.COACH_CHAT_OFF || '') === '1';

// Lo que el entrenador puede preguntar y el modelo sí puede contestar.
// Es el mismo contenido de ayuda.html menos la sección El dinero, que
// no pasa por aquí.
const COACH_KB = `Eres la ayuda de Cada Punto para entrenadores. Cada Punto es
una recaudación por promesas: los padrinos de un nene prometen unos centavos por
cada punto que anote ESE nene jugando The Fortress, dentro de un día de juego que
pone el programa. Cuando cierra la ventana se cobra solo.

Contesta SOLO con lo que está aquí abajo. Hablas con un entrenador, no con un
padrino.

QUÉ ES CADA PUNTO Y CÓMO SE EMPIEZA
- Cada Punto es una recaudación por promesas para equipos y programas
  deportivos. Los padrinos de cada nene prometen unos centavos por cada punto
  que anote ese nene jugando The Fortress. Se juega el día de juego, el juego
  guarda los puntos solo, y de ahí sale lo que recaudó el programa.
- El entrenador NO pone marcadores. No hay nada que escribir. Eso cambió.
- Lo lleva Gostar Digital LLC, en Puerto Rico.
- Nadie se da de alta solo. NO hay un botón de crear tu cuenta ni de
  crear tu campaña. Las campañas las abrimos nosotros a mano, una por
  una. El programa no abre nada por su lado: nos lo pide y se lo
  montamos.
- Un programa que quiere empezar lo dice en cadapunto.com/contact.html
  ("Habla con nosotros"), o escribe a gostardigital@gmail.com. Cuenta de
  qué escuela, club o grupo es y para qué quiere recaudar. Nosotros
  armamos la campaña, el tablero y los enlaces, y le damos su código a
  cada entrenador. Nada sale al aire hasta que el programa lo diga.
- Así que a quien pregunte cómo apuntarse, cómo empezar, cómo abrir una
  cuenta o cómo crear una campaña, mándalo a cadapunto.com/contact.html o
  al correo. No le digas que se registre ni que cree nada por su cuenta,
  porque eso no existe.
- Un entrenador que YA tiene su código no tiene que apuntarse a nada:
  entra directo en cadapunto.com/mi-equipo.html.
- Lo que se apunta con un enlace es otra cosa: son los jugadores, con el
  enlace que su entrenador le manda al grupo del equipo.

EL FORTRESS — EL JUEGO SOBRE EL QUE SE RECAUDA
- The Fortress es el juego. Se juega en cadapunto.com/fortress-vr.html, en el
  teléfono, la tableta o la computadora. No hace falta instalar nada.
- Qué es: cinco bolas puestas delante, en 2-1-2. Se enciende una cadena de bolas
  en orden y hay que repetirla tocándolas. Cada ronda la cadena crece en una.
  Aguantar doce rondas son 78 puntos.
- Los puntos de una cadena son 1+2+3+... hasta el nivel que aguantó. Por eso
  cada ronda que se aguanta vale más que la anterior.
- Si se falla, se acabó esa tirada y empieza otra. Dentro de un cuarto se puede
  tirar las veces que dé el tiempo.
- Práctica: gratis, sin reloj, todas las veces que se quiera. No se guarda nada
  y no se cobra nada. El botón dice "Práctica · sin reloj".
- Scrimmage: los cuatro cuartos completos, para probar cómo se siente. Tampoco
  cuenta para nada.
- Con un casco de realidad virtual también se puede practicar, con la cabeza en
  vez de con el dedo. Pero el día de juego NO se juega con casco: sólo pantalla.
  Es a propósito, para no tener que repartir cascos a nadie.

ENTRAR
- Entra en cadapunto.com/mi-equipo.html con el código que se le dio.
- Se escribe una sola vez: ese teléfono queda sabiendo quién es, para la
  plantilla y el tablero.
- Si se lo vuelve a pedir, está en otro teléfono, otro navegador o una ventana
  privada.
- Si dice que el código no sirve: casi siempre son espacios pegados al copiar y
  pegar. Si sigue, que escriba al correo.
- Códigos perdidos no se pueden buscar: se guardan cifrados. Se hace uno nuevo.

LA PLANTILLA (cadapunto.com/plantilla.html)
- Dos maneras de apuntar jugadores, y valen a la vez: el entrenador pega los
  nombres uno por línea, o manda el enlace de apuntarse al grupo del equipo y
  cada familia se apunta sola. La segunda es la buena: cada nene recibe su
  propio enlace para sus padrinos.
- Un nene que se apuntó y no aparece está esperando aprobación. Sale arriba, en
  un recuadro anaranjado, con Aprobar y Rechazar. Mientras no se apruebe no sale
  en ningún sitio, y es a propósito.
- Se fue un nene: botón Sacar. Baja al final en gris y deja de salir en el
  tablero. No se borra y vuelve con un toque. Borrar sale después de sacarlo, y
  no se puede si ya tiene promesas encima.
- Nombre mal escrito: botón Arreglar, en su fila. Ahí mismo se le cambia la
  escuadra.

EL DÍA DE JUEGO
- La recaudación es UN día de juego. No hay calendario, no hay temporada, no hay
  interescuadra. Eso se quitó.
- El día de juego es una ventana de horas — dos por defecto — que ponemos
  nosotros a petición del programa. Dentro de esa ventana cada nene juega su
  partido, desde donde esté. No hay que juntar a nadie ni prestar equipos.
- El partido de un nene son CUATRO cuartos de cinco minutos. Cada cuarto vale la
  mejor tirada que haya hecho dentro de ese cuarto, y los cuatro se suman. Por
  eso cada tirada cuenta: no es el total del cuarto, es la mejor.
- Un cuarto que no se termine dentro de la ventana vale cero. Si se le muere la
  batería, que vuelva a abrir el mismo enlace: los cuartos que ya puso siguen
  puestos y sigue donde iba, mientras la ventana esté abierta.
- Un nene juega su partido UNA vez. Un cuarto ya guardado no se vuelve a jugar,
  ni recargando ni con otro teléfono.
- Las promesas se cierran cuando ABRE el día de juego. Después no entra ninguna,
  y es a propósito: prometer sabiendo lo que anotó el nene no es prometer.
- Para abrir un día de juego, que nos escriba con la fecha y la hora. No hay
  botón para eso: lo ponemos nosotros.

EL MARCADOR SE PONE SOLO
- Nadie escribe un marcador. El juego guarda cada cuarto según se juega. El
  entrenador no tiene nada que hacer el día de juego, y no puede cambiar un
  número aunque quiera.
- El tablero en vivo está en cadapunto.com/tablero.html y también sale desde Mi
  equipo, en "Ver el tablero". Enseña cada nene con sus cuatro cuartos llegando,
  su total, y si ya terminó o va por el segundo. Se refresca solo.
- Cuando cierra la ventana se cobra solo: a cada padrino le sale su enlace de
  pago por correo, sin que nadie apriete nada.
- Se recauda por los puntos que anotó el nene. No se gana ni se pierde contra
  nadie: no hay rival. El único rival es la cadena.
- Si un cuarto se guardó mal, que avise y lo miramos. Se corrige y se les dice a
  los padrinos.

DE QUÉ MÁS PUEDES HABLAR
- Hablas con gente de baloncesto, así que puedes hablar de baloncesto. Reglas,
  posiciones, ejercicios, cómo montar una práctica, cómo llevar un grupo de
  nenes, qué trabajar con un equipo que no tira bien — contesta normal, corto y
  con gusto, y vuelve a lo tuyo si viene a cuento.
- Puedes hablar de baloncesto de Puerto Rico en general, de su historia y de lo
  que significa allí, con cariño y sin inventar.
- PERO hay una raya que no se cruza: NADA de lo que pase ahora mismo o de lo que
  haya que comprobar. No sabes quién ganó anoche, ni cómo va la tabla, ni quién
  juega en qué equipo esta temporada, ni qué pasó en un partido, ni lo que haya
  salido en las noticias. No lo sabes y no lo puedes mirar. Dilo tal cual: "de lo
  que está pasando ahora no me entero", y sigue.
- Tampoco sabes nada del equipo de quien te escribe: ni cuándo es su día de
  juego, ni quién está en su plantilla, ni cómo van de puntos. Eso lo ve él en
  su propia página, entrando con su código, y los puntos en el tablero.
- Nunca des un nombre, una fecha, un resultado o una cifra que no te hayan dado
  aquí. Si no lo sabes, dilo. Decir "no sé" es la respuesta correcta y no es un
  fallo.
- Nada de política, religión, salud, dinero de nadie, ni consejo legal. Si sale,
  dilo con buen modo y vuelve al baloncesto.

CÓMO CONTESTAS
- Por defecto, en el idioma que te diga el sistema abajo del todo, aunque la
  pregunta venga escrita en el otro. El que lee tiene la página puesta en ese
  idioma y no quiere que se le cambie sola a media conversación.
- PERO si te PIDEN cambiar de idioma — "háblame en inglés", "can we talk in
  English", "en español por favor" — cambias ahí mismo y sigues en ese idioma el
  resto de la conversación. Eso lo manda el que pregunta, no la página. Nunca le
  digas que sólo puedes contestar en un idioma, porque no es verdad.
- Cuando cambies, dile de paso que con el botón EN/ES de arriba cambia la página
  entera, no sólo lo que tú le contestas.
- Corto: tres o cuatro frases. Dile qué botón tocar y en qué página.
- Palabras llanas. Nada de jerga ni de listas largas.
- No te inventes NADA. Ni una cifra, ni una fecha, ni un porcentaje, ni un plazo,
  ni un nombre de página que no esté aquí arriba.
- No prometas lo que vamos a hacer nosotros.
- Nunca des códigos, nombres de nenes, ni nada de otro equipo. Si te lo piden,
  dile que eso no lo puedes dar.
- Si te preguntan algo de Cada Punto que no esté contestado aquí arriba — de la
  plataforma, de una campaña, de un cobro, de algo que haya que mirar por dentro
  — dilo y manda a escribir a gostardigital@gmail.com. Decir "eso no lo sé,
  escríbenos" es la respuesta correcta y no es un fallo.
- Pero no mandes al correo una pregunta de baloncesto que puedas contestar tú.
  Un entrenador que pregunta cómo trabajar los tiros libres quiere una respuesta,
  no una dirección.
- Eres una ayuda, no una persona. No tienes nombre y no dices que eres John ni
  nadie de Gostar Digital.
- Pero hablas DE PARTE de Cada Punto, no de fuera. Cuando digas lo que
  hacemos, di "nosotros": nosotros armamos la campaña, nosotros damos los
  códigos, escríbenos. Nunca "ellos", ni "la empresa", ni "el equipo de
  Cada Punto" — estás en su propia página y eso suena a que esto es de
  otra gente.`;

// ── Lo de dinero, palabra por palabra ─────────────────────────────
// El mismo texto que ayuda.html y que cuadra con terms.html y
// custodia.html. Si una de esas cambia, esto cambia. El modelo no
// toca ninguna de estas respuestas.
const DINERO = [
  { k: /(cu[aá]ndo|cuando|when).{0,40}(me pag|pagan|cobro yo|remit|get paid|paid)|(pag|paid|remit).{0,25}(cu[aá]ndo|when)|d[ií]a 15|15th/i,
    es: 'Te pagamos el día 1 y el día 15 de cada mes, por lo cobrado hasta ese día. Si por alguna razón no podemos remitir en esa fecha, te lo decimos antes de que pase.',
    en: 'We pay on the 1st and the 15th of each month, for whatever has been collected by then. If for any reason we cannot send on that date, we tell you before it passes.' },

  { k: /(a d[oó]nde|ad[oó]nde|donde).{0,30}(pag|cobr)|cobro\.html|ath m[oó]vil|where.{0,20}pay me|bank|cuenta de banco/i,
    es: 'A donde nos digas en cadapunto.com/cobro.html, con el mismo código. Es la cuenta ATH Móvil Business de la organización. Hazlo una vez, al principio.',
    en: 'Wherever you tell us at cadapunto.com/cobro.html, with the same code. It is the organisation’s ATH Móvil Business account. Do it once, at the start.' },

  { k: /(cu[aá]nto|qu[eé]).{0,30}(se quedan|cobran ustedes|comisi[oó]n|se llevan)|20\s?%|veinte por ciento|how much.{0,20}keep|your cut|commission|fee/i,
    es: 'Nada de lo tuyo. El programa recibe el 100% de lo prometido. Nuestro 20% se le suma al pago del padrino, encima de la promesa: una promesa de $25 es un pago de $25.00 más $5.00, y al programa le llegan los $25 completos. Sin cuota de entrada, sin mensualidad y sin contrato.',
    en: 'Nothing of yours. The program receives 100% of what was pledged. Our 20% is added to the padrino’s payment, on top of the pledge: a $25 pledge is a payment of $25.00 plus $5.00, and the program receives the full $25. No setup fee, no monthly fee, no contract.' },

  { k: /deducib|impuesto|tax|irs|recibo para|hacienda|donaci[oó]n deduc|write ?off|501/i,
    es: 'No decimos que lo sea. Gostar Digital LLC es una empresa con fines de lucro, no una organización sin fines de lucro, y no emitimos recibos para impuestos. Si a un padrino le importa cómo se trata su pago, que lo consulte con su asesor.',
    en: 'We do not say that it is. Gostar Digital LLC is a for-profit company, not a non-profit, and we do not issue tax receipts. If how their payment is treated matters to a padrino, they should ask their own advisor.' },

  { k: /(tope|m[aá]ximo|l[ií]mite|fortuna|m[ií]nimo|minimum|cap\b|owe|debiendo|deber[aá]|too much)/i,
    es: 'El padrino pone su propio tope cuando promete, y el tope manda — no puede terminar debiendo más de eso. También hay un cobro mínimo de $5.',
    en: 'The padrino sets their own cap when they pledge, and the cap wins — they cannot end up owing more than that. There is also a $5 minimum charge.' },

  { k: /(cu[aá]ndo|cuando|when).{0,40}(cuenta|factura|cobr|bill|invoice|charge)|le llega la cuenta|les llega/i,
    es: 'Cuando pones el marcador, el juego se cierra y se calcula lo de cada padrino. Las cuentas salen desde el admin, así que puede haber unas horas entre que pones el marcador y que les llega.',
    en: 'When you post the score the game closes and every padrino’s amount is worked out. The bills go out from the admin side, so there can be a few hours between your posting the score and their receiving it.' },
];

// Cualquier otra cosa que huela a dinero y no sea una de las de arriba
// tampoco la contesta el modelo. Va a la página y al correo.
const OLOR_A_DINERO = /\$|dinero|plata|pago|pagar|pagos|cobr|factura|precio|cuesta|tarifa|por ciento|%|money|payment|pay\b|paid|charge|refund|reembolso|devoluci[oó]n|stripe|tarjeta|card\b|banco|bank/i;

const SIN_CIFRAS = {
  es: 'Eso es de dinero, y no te lo voy a contestar de memoria. Está escrito en la sección El dinero de esta misma página — bájale y ábrela. Si lo que preguntas no está ahí, escríbenos a gostardigital@gmail.com y te contestamos el mismo día.',
  en: 'That is a money question, and I will not answer it from memory. It is written out in The money section of this same page — scroll down and open it. If what you are asking is not there, write to gostardigital@gmail.com and we answer the same day.',
};

// ¿En qué idioma pregunta? Una tilde, una ñ o un signo de abrir ya
// lo deciden. Si no trae ninguno — y mucha gente escribe sin tildes —
// se cuentan palabras de cada lado y gana la que tenga más. Mirar sólo
// si había palabras inglesas contestaba en español a "is this tax
// deductible", que no lleva ninguna de las palabras obvias.
const PAL_ES = /\b(que|como|cuando|donde|cual|cuanto|para|por|porque|mi|mis|me|el|la|los|las|un|una|del|con|hay|esto|esta|eso|no|si|puedo|tengo|quiero|juego|juegos|marcador|equipo|codigo|jugador|jugadores|nene|nenes|plantilla|escuadra|padrino|padrinos|pongo|poner|apunt\w*|sirve)\b/g;
const PAL_EN = /\b(the|is|are|was|how|when|what|where|why|which|do|does|did|can|could|should|my|i|you|it|this|that|they|not|and|of|for|with|score|roster|game|games|team|pay|paid|sign|player|players|code|squad|padrino|padrinos|cannot|about)\b/g;
function idioma(t) {
  const s = String(t || '').toLowerCase();
  if (/[áéíóúñ¿¡]/.test(s)) return 'es';
  const es = (s.match(PAL_ES) || []).length;
  const en = (s.match(PAL_EN) || []).length;
  return en > es ? 'en' : 'es';
}

// El idioma lo decide el botón de la página, no la frase suelta. Una
// conversación en español con una pregunta escrita en inglés seguía
// en español para el que la lee; adivinarlo mensaje a mensaje la partía
// en dos. Si la página no lo manda — una copia vieja en caché — se
// vuelve a adivinar como antes.
function idiomaDe(body, pregunta) {
  const l = String((body && body.lang) || '').toLowerCase();
  if (l === 'es' || l === 'en') return l;
  return idioma(pregunta);
}

// La cuenta va en la base, no en memoria. En memoria tenía un agujero:
// Render reinicia el servicio cuando le parece y en cada reinicio la
// cuenta volvía a cero. Un tope que se borra solo no es un tope.
//
// No se guarda el código, se guarda un hash. Esa tabla no sirve para
// entrar en ningún sitio.
const crypto = require('crypto');
const huella = (code) =>
  crypto.createHash('sha256').update(String(code)).digest('hex').slice(0, 24);

// Sube los tres cubos y dice cómo quedaron. Si no se puede contar, NO
// se llama al modelo — se falla cerrado. Entre dejar a un entrenador sin
// respuesta un rato y una factura que no vimos venir, preferimos lo
// primero: abajo tiene las 24 preguntas y el correo.
async function pasaElTope(code) {
  const ahora = new Date();
  const dia = ahora.toISOString().slice(0, 10);
  const hora = dia + 'T' + String(ahora.getUTCHours()).padStart(2, '0');
  const h = huella(code);

  const bH = 'h:' + h + ':' + hora;
  const bD = 'd:' + h + ':' + dia;
  const bT = 'all:' + dia;

  const { data, error } = await supabase.rpc('coach_chat_bump', { p_buckets: [bH, bD, bT] });
  if (error) {
    console.error('coach/chat no se pudo contar:', error);
    return { ok: false, motivo: 'contador' };
  }
  const c = data || {};
  if ((c[bT] || 0) > LIM_TODOS) return { ok: false, motivo: 'todos' };
  if ((c[bD] || 0) > LIM_DIA)   return { ok: false, motivo: 'dia' };
  if ((c[bH] || 0) > LIM_HORA)  return { ok: false, motivo: 'hora' };
  return { ok: true, hoy: c[bT] || 0 };
}

const TOPE_DICHO = {
  hora: {
    es: 'Son muchas preguntas seguidas. Espera un rato y sigue, o escríbenos a gostardigital@gmail.com y te contesta una persona.',
    en: 'That is a lot of questions at once. Wait a while and carry on, or write to gostardigital@gmail.com and a person will answer you.' },
  dia: {
    es: 'Ya hiciste bastantes preguntas hoy. Mañana sigue, y mientras tanto escríbenos a gostardigital@gmail.com.',
    en: 'You have asked plenty today. Carry on tomorrow, and in the meantime write to gostardigital@gmail.com.' },
  todos: {
    es: 'El chat llegó a su tope de hoy. Las preguntas de esta página están completas, y si no está lo tuyo escríbenos a gostardigital@gmail.com.',
    en: 'The chat has reached today\u2019s limit. The questions on this page are complete, and if yours is not there write to gostardigital@gmail.com.' },
  contador: {
    es: 'No puedo contestarte ahora mismo. Las preguntas de esta página están completas, y si no está lo tuyo escríbenos a gostardigital@gmail.com.',
    en: 'I cannot answer right now. The questions on this page are complete, and if yours is not there write to gostardigital@gmail.com.' },
};

app.post('/coach/chat', async (req, res) => {
  try {
    const code = String((req.body && req.body.code) || '').trim();
    const inMsgs = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
    if (!code) return res.status(400).json({ error: 'code is required' });
    if (!inMsgs.length) return res.status(400).json({ error: 'messages is required' });

    // 1. La puerta. Se comprueba aquí, no en el navegador.
    const { data: chk, error: chkErr } = await supabase.rpc('builder_check', { p_code: code });
    if (chkErr) {
      console.error('coach/chat builder_check error:', chkErr);
      return res.status(500).json({ error: 'check failed' });
    }
    if (!chk || !chk.ok) return res.status(401).json({ error: 'bad code' });

    // Sólo las últimas, y cortadas. Nadie necesita mandar un libro.
    const msgs = inMsgs
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
      .slice(-10)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 1200) }));
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'last message must be from the user' });
    }

    const pregunta = msgs[msgs.length - 1].content;
    const lang = idiomaDe(req.body, pregunta);

    // 2. El dinero no pasa por el modelo.
    for (const d of DINERO) {
      if (d.k.test(pregunta)) return res.json({ reply: d[lang] || d.es, fixed: true });
    }
    if (OLOR_A_DINERO.test(pregunta)) {
      return res.json({ reply: SIN_CIFRAS[lang], fixed: true });
    }

    if (!ANTHROPIC_API_KEY || CHAT_APAGADO) return res.status(503).json({ error: 'chat is off' });

    // El tope se mira AQUÍ, y no arriba, a propósito: las respuestas
    // fijas de dinero no cuestan nada, así que no tienen por qué
    // gastarle la cuota a nadie. Sólo cuenta lo que llega al modelo.
    const tope = await pasaElTope(code);
    if (!tope.ok) {
      return res.status(429).json({ reply: TOPE_DICHO[tope.motivo][lang], fixed: true });
    }

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        // Sin temperature: estos modelos piensan antes de contestar y
        // no aceptan que se la toquemos. Y max_tokens tiene que dar
        // para lo que piensa MÁS lo que escribe — con 400 se le iba
        // entero en pensar y devolvía una respuesta vacía.
        model: COACH_CHAT_MODEL,
        max_tokens: 1024,
        system: COACH_KB + '\n\nIDIOMA DE ESTA CONVERSACIÓN: ' +
          (lang === 'en' ? 'inglés. Contesta en inglés.'
                         : 'español. Contesta en español.'),
        messages: msgs,
      }),
    });

    if (!r.ok) {
      console.error('coach/chat model error:', r.status, await r.text());
      return res.status(502).json({ error: 'model failed' });
    }

    const out = await r.json();
    // La respuesta puede venir en varios bloques, y el primero puede ser
    // lo que pensó, no lo que dice. Se juntan los de texto y ya.
    const reply = (out.content || [])
      .filter((c) => c && c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('\n')
      .trim();
    if (!reply) {
      console.error('coach/chat respuesta sin texto — stop_reason:', out.stop_reason,
                    '| bloques:', (out.content || []).map((c) => c.type).join(','));
      return res.status(502).json({ error: 'empty reply' });
    }

    // 3. El cinturón, por si el modelo se fue de cifras de todas
    //    formas. Si trae un número de dinero o un porcentaje, la
    //    respuesta se tira entera — no se recorta.
    if (/\$\s?\d|\d+\s?%|\bpor ciento\b|\bpercent\b/i.test(reply)) {
      console.warn('coach/chat: respuesta con cifras descartada');
      return res.json({ reply: SIN_CIFRAS[lang], fixed: true });
    }

    console.log('coach/chat ok — preguntas al modelo hoy:', tope.hoy, 'de', LIM_TODOS);
    res.json({ reply });
  } catch (e) {
    console.error('coach/chat error:', e);
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

// El barrido cada cinco minutos, y uno al arrancar: si Render reinició
// el servicio justo cuando se cerraba una ventana, el tick siguiente
// podría tardar, y el de arranque lo coge. Treinta segundos de margen
// para que el servicio esté entero antes de cobrarle a nadie.
//
// Si este servicio se duerme (plan gratis), el reloj se duerme con él.
// Entonces hace falta que algo de fuera le llame a /challenge-sweep
// con la SWEEP_KEY, o simplemente a / para despertarlo.
setTimeout(() => {
  barrerRetos().catch(e => console.error('Barrido de arranque:', e.message));
}, 30 * 1000);

setInterval(() => {
  barrerRetos().catch(e => console.error('Barrido:', e.message));
}, SWEEP_EVERY);

// Los recordatorios, cada hora. No hace falta más fino: lo que decide
// si toca o no es el DÍA de la promesa, no el minuto. La función se
// salta ella misma las horas indecentes, así que de las veinticuatro
// llamadas al día sólo trabajan las de horario de Puerto Rico.
//
// No hay barrido de arranque aquí, a propósito: un reinicio de Render
// no es razón para escribirle a un padrino, y como muy tarde se coge
// en la hora siguiente.
setInterval(() => {
  barrerRecordatorios().catch(e => console.error('Recordatorios:', e.message));
}, RECORDAR_EVERY);
