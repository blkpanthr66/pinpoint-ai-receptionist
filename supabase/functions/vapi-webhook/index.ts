import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

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

    let durationSeconds = null;
    if (call?.startedAt && call?.endedAt) {
      const start = new Date(call.startedAt).getTime();
      const end = new Date(call.endedAt).getTime();
      durationSeconds = Math.round((end - start) / 1000);
    }

    const outcome = detectOutcome(transcript, summary);

    console.log(`Call ${vapiCallId} ended — outcome: ${outcome}, duration: ${durationSeconds}s`);

    if (!vapiCallId) {
      return new Response(JSON.stringify({ error: 'No call ID in payload' }), { status: 400, headers: corsHeaders });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data, error } = await supabase
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

    if (error) {
      console.error('Supabase update error:', error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }

    console.log(`Lead ${data?.id} updated with call outcome: ${outcome}`);

    return new Response(JSON.stringify({ success: true, lead_id: data?.id, outcome }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('vapi-webhook error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
