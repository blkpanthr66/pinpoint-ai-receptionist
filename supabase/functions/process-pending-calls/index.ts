import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const VAPI_API_KEY = Deno.env.get('VAPI_API_KEY')!;
const VAPI_ASSISTANT_ID = '029b12f2-0cf2-4354-97d2-c152c74e4f2d';
const VAPI_PHONE_NUMBER_ID = 'd191616b-d191-41ff-ad06-9657d5832a59';
const MAX_CALL_ATTEMPTS = 5;

function isBusinessHoursNZ(): boolean {
  const now = new Date();
  const nzTime = new Date(now.toLocaleString('en-US', { timeZone: 'Pacific/Auckland' }));
  const hour = nzTime.getHours();
  const day = nzTime.getDay();
  return day >= 1 && day <= 5 && hour >= 9 && hour < 18;
}

async function fireVapiCall(phone: string, name: string, email: string, message: string): Promise<string> {
  const res = await fetch('https://api.vapi.ai/call/phone', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VAPI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      assistantId: VAPI_ASSISTANT_ID,
      phoneNumberId: VAPI_PHONE_NUMBER_ID,
      customer: { number: phone, name },
      assistantOverrides: {
        variableValues: {
          lead_name: name,
          lead_email: email,
          lead_message: message || 'No message provided',
        },
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Vapi error: ${JSON.stringify(data)}`);
  return data.id;
}

Deno.serve(async () => {
  if (!isBusinessHoursNZ()) {
    return new Response(JSON.stringify({ skipped: 'outside business hours NZ' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: leads, error } = await supabase
    .from('leads')
    .select('*, contacts(*)')
    .eq('call_status', 'pending')
    .lt('call_attempt_count', MAX_CALL_ATTEMPTS)
    .not('contacts.phone', 'is', null)
    .limit(10);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  const results = [];
  for (const lead of leads || []) {
    const contact = lead.contacts;
    if (!contact?.phone) continue;
    try {
      const vapiCallId = await fireVapiCall(
        contact.phone,
        contact.name || 'there',
        contact.email || '',
        lead.raw_message || '',
      );
      await supabase.from('leads').update({
        call_status: 'called',
        call_attempted_at: new Date().toISOString(),
        vapi_call_id: vapiCallId,
        call_attempt_count: (lead.call_attempt_count ?? 0) + 1,
        call_error: null,
      }).eq('id', lead.id);
      results.push({ lead_id: lead.id, status: 'called', vapi_call_id: vapiCallId });
    } catch (err) {
      const attempts = (lead.call_attempt_count ?? 0) + 1;
      const isFinal = attempts >= MAX_CALL_ATTEMPTS;
      await supabase.from('leads').update({
        call_attempt_count: attempts,
        call_error: String(err),
        ...(isFinal ? { call_status: 'failed' } : {}),
      }).eq('id', lead.id);
      results.push({ lead_id: lead.id, status: isFinal ? 'failed' : 'error', error: String(err) });
    }
  }

  return new Response(JSON.stringify({ processed: results.length, results }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
