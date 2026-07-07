import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TIDYCAL_TOKEN = Deno.env.get('TIDYCAL_TOKEN');
const BOOKING_TYPE_ID = 413150;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const now = new Date();
  const weekLater = new Date(now);
  weekLater.setDate(weekLater.getDate() + 7);

  const startsAt = now.toISOString().split('.')[0] + 'Z';
  const endsAt = weekLater.toISOString().split('.')[0] + 'Z';

  const url = `https://tidycal.com/api/booking-types/${BOOKING_TYPE_ID}/timeslots?starts_at=${encodeURIComponent(startsAt)}&ends_at=${encodeURIComponent(endsAt)}`;

  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${TIDYCAL_TOKEN}`,
      'Accept': 'application/json',
    },
  });

  const data = await res.json();

  if (!res.ok) {
    return new Response(JSON.stringify({ error: 'Failed to fetch timeslots', details: data }), {
      status: res.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Today's date in NZ timezone for same-day detection
  const todayNZ = now.toLocaleDateString('en-NZ', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' });

  // Pick 3 slots spaced at least 1 hour apart
  const allSlots: { starts_at: string }[] = data.data || [];
  const picked: { starts_at: string }[] = [];
  let lastPickedTime = 0;

  for (const slot of allSlots) {
    const slotTime = new Date(slot.starts_at).getTime();
    if (picked.length === 0 || slotTime - lastPickedTime >= 60 * 60 * 1000) {
      picked.push(slot);
      lastPickedTime = slotTime;
    }
    if (picked.length === 3) break;
  }

  const slots = picked.map((slot) => {
    const d = new Date(slot.starts_at);

    const slotDateNZ = d.toLocaleDateString('en-NZ', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' });
    const isToday = slotDateNZ === todayNZ;

    const timePart = d.toLocaleString('en-NZ', {
      timeZone: 'Pacific/Auckland',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

    const display = isToday
      ? `Today at ${timePart}`
      : d.toLocaleString('en-NZ', {
          timeZone: 'Pacific/Auckland',
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });

    return { display, starts_at: slot.starts_at };
  });

  return new Response(JSON.stringify({ available_slots: slots }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
