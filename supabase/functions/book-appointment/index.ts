import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TIDYCAL_TOKEN = Deno.env.get('TIDYCAL_TOKEN');
const BOOKING_TYPE_ID = 413150;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function cleanEmail(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+at\s+/gi, '@')
    .replace(/\s+dot\s+/gi, '.')
    .replace(/\s+/g, '')
    .trim();
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const name = (body.name || '').trim();
  const email = cleanEmail(body.email || '');
  const startsAt = (body.start_at || body.starts_at || '').trim();
  const timezone = body.timezone || 'Pacific/Auckland';

  console.log('Received booking request:', { name, email, startsAt, timezone });

  if (!name || !email || !startsAt) {
    return new Response(JSON.stringify({ error: 'Missing required fields', received: { name, email, startsAt } }), {
      status: 422,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const tidyCalPayload = { name, email, starts_at: startsAt, timezone };
  console.log('Calling TidyCal with:', JSON.stringify(tidyCalPayload));

  const tidyCalRes = await fetch(`https://tidycal.com/api/booking-types/${BOOKING_TYPE_ID}/bookings`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TIDYCAL_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(tidyCalPayload),
  });

  const tidyCalData = await tidyCalRes.json();
  console.log('TidyCal response:', tidyCalRes.status, JSON.stringify(tidyCalData));

  if (!tidyCalRes.ok) {
    return new Response(JSON.stringify({ error: 'TidyCal booking failed', details: tidyCalData }), {
      status: tidyCalRes.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ success: true, booking: tidyCalData }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
