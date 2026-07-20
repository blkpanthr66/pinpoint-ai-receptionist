import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const TENANT_ID = '07cf91e2-6e49-463e-95b9-83fb1aa0839a';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function detectOutcome(transcript: string, summary: string): string {
  const text = (transcript + ' ' + summary).toLowerCase();
  if (text.includes('book') && (text.includes('confirm') || text.includes('appointment') || text.includes('schedule') || text.includes('slot'))) {
    return 'booked';
  }
  if (text.includes('not interested') || text.includes('no thank') || text.includes('dont need') || text.includes("don't need")) {
    return 'not_interested';
  }
  if (text.includes('call back') || text.includes('later') || text.includes('not a good time')) {
    return 'callback_requested';
  }
  if (text.includes('voicemail') || text.includes('leave a message')) {
    return 'voicemail';
  }
  return 'no_outcome';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const payload = await req.json();
    const message = payload.message;

    if (!message || message.type !== 'end-of-call-report') {
      return new Response(JSON.stringify({ ignored: true }), { headers: corsHeaders });
    }

    const call = message.call;
    const vapiCallId = call?.id;
    const transcript = message.transcript || '';
    const summary = message.summary || '';
    const recordingUrl = message.recordingUrl || null;
    const endedReason = message.endedReason || null;
    const callerPhone = call?.customer?.number || null;
    const isInbound = call?.type === 'inboundPhoneCall';

    let durationSeconds = null;
    if (call?.startedAt && call?.endedAt) {
      const start = new Date(call.startedAt).getTime();
      const end = new Date(call.endedAt).getTime();
      durationSeconds = Math.round((end - start) / 1000);
    }

    const outcome = detectOutcome(transcript, summary);

    console.log(`Call ${vapiCallId} ended — outcome: ${outcome}, duration: ${durationSeconds}s, inbound: ${isInbound}`);

    if (!vapiCallId) {
      return new Response(JSON.stringify({ error: 'No call ID in payload' }), { status: 400, headers: corsHeaders });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Try to update an existing lead (outbound call flow)
    const { data: updated, error: updateError } = await supabase
      .from('leads')
      .update({
        call_transcript: transcript,
        call_summary: summary,
        call_outcome: outcome,
        call_duration_seconds: durationSeconds,
        call_ended_reason: endedReason,
        call_recording_url: recordingUrl,
        call_status: 'completed',
      })
      .eq('vapi_call_id', vapiCallId)
      .select('id')
      .single();

    if (updateError && updateError.code !== 'PGRST116') {
      console.error('Supabase update error:', updateError);
      return new Response(JSON.stringify({ error: updateError.message }), { status: 500, headers: corsHeaders });
    }

    if (updated) {
      console.log(`Lead ${updated.id} updated with call outcome: ${outcome}`);
      return new Response(JSON.stringify({ success: true, lead_id: updated.id, outcome }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // No existing lead matched — create a new one for this inbound call
    console.log(`No lead found for call ${vapiCallId}, creating inbound lead`);

    // If an appointment was booked during this call, Aria collected the caller's
    // real name/email/phone — reuse them rather than leaving the contact blank.
    let booked: { attendee_name?: string; attendee_email?: string; attendee_phone?: string } | null = null;
    if (call?.startedAt) {
      const from = new Date(new Date(call.startedAt).getTime() - 60_000).toISOString();
      const to = new Date(Date.now() + 60_000).toISOString();
      const { data: appts } = await supabase
        .from('appointments')
        .select('attendee_name, attendee_email, attendee_phone')
        .gte('created_at', from)
        .lte('created_at', to)
        .order('created_at', { ascending: false })
        .limit(1);
      booked = appts?.[0] ?? null;
      if (booked) console.log('Matched appointment booked during call:', booked.attendee_email);
    }

    const contactName = booked?.attendee_name || 'Phone Caller';
    const contactEmail = booked?.attendee_email || null;
    const contactPhone = booked?.attendee_phone || callerPhone || null;

    // Find an existing contact by email, then phone; otherwise create one.
    // Always create a contact so the lead is never left showing "Unknown".
    let contactId: string | null = null;

    if (contactEmail) {
      const { data: byEmail } = await supabase
        .from('contacts').select('id').eq('email', contactEmail).maybeSingle();
      if (byEmail) contactId = byEmail.id;
    }
    if (!contactId && contactPhone) {
      const { data: byPhone } = await supabase
        .from('contacts').select('id').eq('phone', contactPhone).maybeSingle();
      if (byPhone) contactId = byPhone.id;
    }

    if (contactId) {
      // Backfill any details we now know but the existing contact is missing
      const patch: Record<string, string> = {};
      if (contactEmail) patch.email = contactEmail;
      if (contactPhone) patch.phone = contactPhone;
      if (booked?.attendee_name) patch.name = booked.attendee_name;
      if (Object.keys(patch).length) {
        await supabase.from('contacts').update(patch).eq('id', contactId);
      }
    } else {
      const { data: newContact, error: contactErr } = await supabase
        .from('contacts')
        .insert({
          name: contactName,
          email: contactEmail,
          phone: contactPhone,
          source: 'phone',
          tenant_id: TENANT_ID,
        })
        .select('id')
        .single();
      if (contactErr) console.error('Failed to create contact:', contactErr.message);
      contactId = newContact?.id || null;
    }

    const aiSummary = summary || (transcript ? transcript.slice(0, 200) : 'Inbound phone call');

    const { data: newLead, error: insertError } = await supabase
      .from('leads')
      .insert({
        contact_id: contactId,
        classification: 'phone_enquiry',
        source: 'phone',
        status: 'new',
        urgency: 'normal',
        raw_message: transcript,
        ai_summary: aiSummary,
        call_status: 'completed',
        call_transcript: transcript,
        call_summary: summary,
        call_outcome: outcome,
        call_duration_seconds: durationSeconds,
        call_ended_reason: endedReason,
        call_recording_url: recordingUrl,
        vapi_call_id: vapiCallId,
        tenant_id: TENANT_ID,
      })
      .select('id')
      .single();

    if (insertError) {
      console.error('Failed to create inbound lead:', insertError);
      return new Response(JSON.stringify({ error: insertError.message }), { status: 500, headers: corsHeaders });
    }

    console.log(`Inbound lead ${newLead?.id} created — outcome: ${outcome}`);
    return new Response(JSON.stringify({ success: true, lead_id: newLead?.id, outcome, created: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('vapi-webhook error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
