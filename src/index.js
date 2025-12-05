// Cloudflare Worker to accept webhook payloads and insert NoCall records into Salesforce
const API_VERSION = 'v58.0';

async function fetchAccessToken(env) {
  const loginUrl = env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';
  const params = new URLSearchParams({
    grant_type: 'password',
    client_id: env.SALESFORCE_CLIENT_ID,
    client_secret: env.SALESFORCE_CLIENT_SECRET,
    username: env.SALESFORCE_USERNAME,
    password: `${env.SALESFORCE_PASSWORD}${env.SALESFORCE_SECURITY_TOKEN || ''}`,
  });

  const response = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });

  if (!response.ok) {
    const errorBody = await safeJson(response);
    throw new Error(`Salesforce auth failed (${response.status}): ${JSON.stringify(errorBody)}`);
  }

  return response.json();
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return { message: 'Failed to parse JSON', error: String(error) };
  }
}

async function createRecord(instanceUrl, token, objectName, body) {
  const response = await fetch(
    `${instanceUrl}/services/data/${API_VERSION}/sobjects/${objectName}/`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const errorBody = await safeJson(response);
    throw new Error(
      `Failed to create ${objectName} (${response.status}): ${JSON.stringify(errorBody)}`
    );
  }

  return response.json();
}

function buildAttributionRecords(callId, attributions = []) {
  return attributions
    .filter((item) => item && (item.label || item.value))
    .map((item) => ({
      NoCall_Call__c: callId,
      Label__c: item.label ?? null,
      Value__c: item.value ?? null,
      External_Id__c: item.externalId ?? null,
    }));
}

function mapCallPayload(callPayload) {
  if (!callPayload || typeof callPayload !== 'object') return callPayload;

  const mapped = { ...callPayload };

  // Convenience mapping: allow a generic `message` field to populate Conversation__c
  if (callPayload.message && !callPayload.Conversation__c) {
    mapped.Conversation__c = callPayload.message;
  }

  // Optional: allow `notes` alias to populate Notes__c for shorter payloads
  if (callPayload.notes && !callPayload.Notes__c) {
    mapped.Notes__c = callPayload.notes;
  }

  return mapped;
}

async function handleRequest(request, env) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method Not Allowed' }, 405);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (error) {
    return jsonResponse({ error: 'Invalid JSON payload', detail: String(error) }, 400);
  }

  if (!payload.call || typeof payload.call !== 'object') {
    return jsonResponse({ error: 'Missing call object in payload' }, 400);
  }

  const token = await fetchAccessToken(env);
  const callBody = mapCallPayload(payload.call);

  const callResponse = await createRecord(token.instance_url, token.access_token, 'NoCall_Call__c', callBody);

  const callId = callResponse.id;
  const attributions = buildAttributionRecords(callId, payload.attributions);
  let attributionIds = [];

  if (attributions.length > 0) {
    attributionIds = await Promise.all(
      attributions.map((record) =>
        createRecord(token.instance_url, token.access_token, 'NoCall_Attribution__c', record).then(
          (result) => result.id
        )
      )
    );
  }

  return jsonResponse({ callId, attributionIds }, 201);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      return jsonResponse({ error: 'Unexpected error', detail: String(error) }, 500);
    }
  },
};
