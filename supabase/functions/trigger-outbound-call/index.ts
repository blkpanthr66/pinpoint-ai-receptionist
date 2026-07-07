import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const VAPI_API_KEY = Deno.env.get('VAPI_API_KEY')!;
const VAPI_ASSISTANT_ID = '029b12f2-0cf2-4354-97d2-c152c74e4f2d';
const VAPI_PHONE_NUMBER_ID = 'd191616b-d191-41ff-ad06-9657d5832a59';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function isBusinessHoursNZ(): boolean {
  const now = new Date();
  const nzTime = new Date(now.toLocaleString('en-US', { timeZone: 'Pacific/Auckland' }));
  const hour = nzTime.getHours();
  const day = nzTime.getDay();
  const isWeekday = day >= 1 && day <= 5;
  const isWorkingHour = hour >= 9 && hour < 18;
  return isWeekday && isWorkingHour;
}

async function fireVapiCall(phone: string, name: string, email: string, message: string): Promise<string> {
  const body = {
    assistantId: VAPI_ASSISTANT_ID,
    phoneNumberId: VAPI_PHONE_NUMBER_ID,
    customer: {
      number: phone,
      name: name,
    },
    assistantOverrides: {
      variableValues: {
        lead_name: name,
        lead_email: email,
        lead_message: message || 'No message provided',
      },
    },
  };

  const res = await fetch('https://api.vapi.ai/call/phone', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VAPI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  console.log('Vapi call response:', res.status, JSON.stringify(data));

  if (!res.ok) {
    throw new Error(`Vapi error: ${JSON.stringify(data)}`);
  }

  return data.id;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const payload = await req.json();
    const record = payload.record || payload;
    const leadId = record.id;

    if (!leadId) {
      return new Response(JSON.stringify({ error: 'No lead id' }), { status: 400, headers: corsHeaders });
    }

    const { data: lead, error: leadErr } = await supabase
      .from('leads')
      .select('*, contacts(*)')
      .eq('id', leadId)
      .single();

    if (leadErr || !lead) {
      return new Response(JSON.stringify({ error: 'Lead not found' }), { status: 404, headers: corsHeaders });
    }

    const contact = lead.contacts;
    const phone = contact?.phone;
    const name = contact?.name || 'there';
    const email = contact?.email || '';
    const message = lead.raw_message || '';

    if (!phone) {
      await supabase.from('leads').update({ call_status: 'no_phone' }).eq('id', leadId);
      return new Response(JSON.stringify({ skipped: 'no phone number' }), { headers: corsHeaders });
    }

    if (!isBusinessHoursNZ()) {
      console.log(`Outside business hours NZ — lead ${leadId} queued as pending`);
      await supabase.from('leads').update({ call_status: 'pending' }).eq('id', leadId);
      return new Response(JSON.stringify({ queued: true, reason: 'outside business hours' }), { headers: corsHeaders });
    }

    const vapiCallId = await fireVapiCall(phone, name, email, message);

    await supabase.from('leads').update({
      call_status: 'called',
      call_attempted_at: new Date().toISOString(),
      vapi_call_id: vapiCallId,
    }).eq('id', leadId);

    return new Response(JSON.stringify({ success: true, vapi_call_id: vapiCallId }), { headers: corsHeaders });

  } catch (err) {
    console.error('trigger-outbound-call error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
