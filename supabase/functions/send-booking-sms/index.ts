import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Sends the caller a booking-link SMS via Twilio. The message content and sender
// live here (server-side) so the assistant only has to pass the destination
// number — no fragile message-passing through the voice model.

const BOOKING_URL = 'https://tidycal.com/ekiwionline/30-minute-meeting';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-pinpoint-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Shared-secret auth (only enforced once PINPOINT_WEBHOOK_SECRET is set)
  const SECRET = Deno.env.get('PINPOINT_WEBHOOK_SECRET');
  if (SECRET && req.headers.get('x-pinpoint-secret') !== SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ success: false, error: 'Invalid JSON' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const to = (body.to || '').trim();
  const firstName = (body.first_name || '').trim();

  if (!to) {
    return new Response(JSON.stringify({ success: false, reason: 'missing_number', message: 'No mobile number was provided.' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const sid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const token = Deno.env.get('TWILIO_AUTH_TOKEN');
  const from = Deno.env.get('TWILIO_SMS_FROM'); // e.g. "PinPoint" or a +number

  if (!sid || !token || !from) {
    console.error('Twilio secrets not configured');
    return new Response(JSON.stringify({ success: false, error: 'SMS not configured' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const greeting = firstName ? `Hi ${firstName}, ` : 'Hi, ';
  const smsBody = `${greeting}thanks for calling PinPoint Local AI! Book your free 30-minute Zoom consult with Peter here: ${BOOKING_URL} — pick a time and pop in your details and you're all set. — Aria`;

  const form = new URLSearchParams({ To: to, From: from, Body: smsBody });

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(`${sid}:${token}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error('Twilio error:', res.status, JSON.stringify(data));
    return new Response(JSON.stringify({ success: false, error: 'Failed to send text', details: data }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  console.log(`Booking SMS sent to ${to} (sid ${data.sid})`);
  return new Response(JSON.stringify({ success: true, sid: data.sid }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
