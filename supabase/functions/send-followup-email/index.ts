import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const FROM_EMAIL = 'hello@pinpointlocal.ai';
const FROM_NAME = 'Peter from PinPoint Local AI';

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Find appointments that ended 2+ hours ago with no follow-up sent
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const { data: appointments, error } = await supabase
    .from('appointments')
    .select('*')
    .lt('starts_at', twoHoursAgo)
    .is('follow_up_sent_at', null)
    .limit(10);

  if (error) {
    console.error('Failed to fetch appointments:', error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  if (!appointments || appointments.length === 0) {
    return new Response(JSON.stringify({ processed: 0, message: 'No appointments to follow up' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const results = [];

  for (const appt of appointments) {
    try {
      const firstName = appt.attendee_name.split(' ')[0];

      const apptDate = new Date(appt.starts_at).toLocaleString('en-NZ', {
        timeZone: 'Pacific/Auckland',
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });

      const emailBody = `
<p>Hi ${firstName},</p>

<p>I hope your Zoom consultation with Peter yesterday went well!</p>

<p>I just wanted to check in — was the session helpful? Did it give you a clearer picture of how AI can work for your business?</p>

<p>If you have any questions or there's anything else you'd like to explore, feel free to reply to this email or give us a call. We're always happy to help.</p>

<p>We look forward to hearing from you.</p>

<p>Warm regards,<br>
Peter Moengaroa<br>
PinPoint Local AI<br>
<a href="https://pinpointlocal.ai">pinpointlocal.ai</a></p>
      `.trim();

      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${FROM_NAME} <${FROM_EMAIL}>`,
          to: [appt.attendee_email],
          subject: `How did your consultation go, ${firstName}?`,
          html: emailBody,
        }),
      });

      const resData = await res.json();

      if (!res.ok) {
        console.error(`Resend error for ${appt.attendee_email}:`, JSON.stringify(resData));
        results.push({ id: appt.id, status: 'error', error: resData });
        continue;
      }

      // Mark follow-up as sent
      await supabase
        .from('appointments')
        .update({ follow_up_sent_at: new Date().toISOString() })
        .eq('id', appt.id);

      console.log(`Follow-up sent to ${appt.attendee_email} (appointment: ${apptDate})`);
      results.push({ id: appt.id, status: 'sent', email: appt.attendee_email });

    } catch (err) {
      console.error(`Error processing appointment ${appt.id}:`, err);
      results.push({ id: appt.id, status: 'error', error: String(err) });
    }
  }

  return new Response(JSON.stringify({ processed: results.length, results }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
