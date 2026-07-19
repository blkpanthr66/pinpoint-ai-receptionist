import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TIDYCAL_TOKEN = Deno.env.get('TIDYCAL_TOKEN');
const BOOKING_TYPE_ID = 413150;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function isWithinNZBusinessHours(date: Date): boolean {
  const nzTime = new Date(date.toLocaleString('en-US', { timeZone: 'Pacific/Auckland' }));
  const hour = nzTime.getHours();
  const day = nzTime.getDay();
  return day >= 1 && day <= 5 && hour >= 9 && hour < 17;
}

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

  const todayNZ = now.toLocaleDateString('en-NZ', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' });

  // Filter to NZ business hours only (9am-5pm Mon-Fri), then pick 3 slots 1hr apart
  const allSlots: { starts_at: string }[] = (data.data || []).filter((slot: { starts_at: string }) =>
    isWithinNZBusinessHours(new Date(slot.starts_at))
  );

  const picked: { starts_at: string }[] = [];
  let lastPickedTime = 0;

  for (const slot of allSlots) {
    const slotTime = new Date(slot.starts_at).getTime();
    if (picked.length === 0 || slotTime - lastPickedTime >= 90 * 60 * 1000) {
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
