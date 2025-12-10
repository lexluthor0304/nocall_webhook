// Cloudflare Worker to accept webhook payloads and insert NoCall records into Salesforce
const API_VERSION = 'v58.0';

class SalesforceError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'SalesforceError';
    this.status = status;
    this.body = body;
  }
}

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
    throw new SalesforceError(
      `Failed to create ${objectName} (${response.status})`,
      response.status,
      errorBody
    );
  }

  return response.json();
}

async function updateRecord(instanceUrl, token, objectName, recordId, body) {
  const response = await fetch(
    `${instanceUrl}/services/data/${API_VERSION}/sobjects/${objectName}/${recordId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const errorBody = await safeJson(response);
    throw new SalesforceError(
      `Failed to update ${objectName} (${response.status})`,
      response.status,
      errorBody
    );
  }

  return { id: recordId };
}

async function queryRecords(instanceUrl, token, soql) {
  const url = `${instanceUrl}/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorBody = await safeJson(response);
    throw new SalesforceError(
      `Salesforce query failed (${response.status})`,
      response.status,
      errorBody
    );
  }

  return response.json();
}

async function findCallByKey(instanceUrl, token, keyField, keyValue) {
  if (!keyValue) return null;

  const escapedValue = String(keyValue).replace(/'/g, "\\'");
  const soql = `SELECT Id FROM NoCall_Call__c WHERE ${keyField} = '${escapedValue}' ORDER BY LastModifiedDate DESC LIMIT 1`;
  const result = await queryRecords(instanceUrl, token, soql);

  return result?.records?.[0]?.Id || null;
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

  return removeUndefined(mapped);
}

function removeUndefined(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined)
  );
}

function formatConversation(messages = []) {
  if (!Array.isArray(messages)) return messages;

  return messages
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return String(entry);

      const { role, content, name, tool_calls: toolCalls, tool_call_id: toolCallId, args } = entry;

      if (role === 'assistant_tool_call') {
        return `${role}: ${JSON.stringify({ name, toolCalls, args })}`;
      }

      if (role === 'tool') {
        return `${role}(${name || toolCallId || ''}): ${JSON.stringify(content)}`;
      }

      return `${role || 'message'}: ${typeof content === 'string' ? content : JSON.stringify(content)}`;
    })
    .join('\n');
}

function buildCallFromWebhook(payload) {
  const conversation = payload.conversation || {};
  const messages = conversation.message || conversation.messages;
  const agentLabel =
    payload.agent && (payload.agent.name || payload.agent.id)
      ? `${payload.agent.name || ''}${payload.agent.name && payload.agent.id ? ' / ' : ''}${payload.agent.id || ''}`
      : undefined;

  return removeUndefined({
    CallRecord_Id__c: payload.id ?? null,
    Call_Status__c: payload.callStatus ?? null,
    From_Phone__c: payload.from ?? null,
    To_Phone__c: payload.to ?? null,
    Recording_Url__c: payload.detailsUrl ?? null,
    EndUser_Id__c: payload.endUser?.id ?? null,
    EndUser_Phone__c: payload.endUser?.phoneNumber ?? null,
    Dialed_At__c: conversation.startTime ?? null,
    Ended_At__c: conversation.endTime ?? null,
    Duration_Sec__c:
      conversation.duration !== undefined && conversation.duration !== null
        ? String(conversation.duration)
        : null,
    Goal_Status__c: conversation.goalStatus ?? null,
    Goal_Result__c: conversation.goalResult ?? null,
    Conversation__c: messages ? formatConversation(messages) : undefined,
    Triggered_By_Label__c: agentLabel,
  });
}

function normalizeAttributions(payload) {
  if (Array.isArray(payload?.attributions)) return payload.attributions;

  const attrs = payload?.endUser?.attributions;
  if (attrs && typeof attrs === 'object') {
    return Object.entries(attrs).map(([label, value]) => ({ label, value }));
  }

  return [];
}

function normalizePayload(payload) {
  if (payload.call && typeof payload.call === 'object') {
    return { call: payload.call, attributions: payload.attributions };
  }

  const call = buildCallFromWebhook(payload);
  const attributions = normalizeAttributions(payload);

  return { call, attributions };
}

async function handleRequest(request, env) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method Not Allowed' }, 405);
  }

  let payload;
  let operation = 'insert';

  try {
    payload = await request.json();
  } catch (error) {
    return jsonResponse({ error: 'Invalid JSON payload', detail: String(error), operation }, 400);
  }

  const normalized = normalizePayload(payload);

  if (!normalized.call || typeof normalized.call !== 'object') {
    return jsonResponse({ error: 'Missing call object in payload', operation }, 400);
  }

  try {
    const token = await fetchAccessToken(env);
    const callBody = mapCallPayload(normalized.call);
    const stableKeyField = 'CallRecord_Id__c';
    let callId;

    const existingCallId = await findCallByKey(
      token.instance_url,
      token.access_token,
      stableKeyField,
      callBody[stableKeyField]
    );

    if (existingCallId) {
      await updateRecord(token.instance_url, token.access_token, 'NoCall_Call__c', existingCallId, callBody);
      callId = existingCallId;
      operation = 'update';
    } else {
      const callResponse = await createRecord(
        token.instance_url,
        token.access_token,
        'NoCall_Call__c',
        callBody
      );

      callId = callResponse.id;
    }

    const attributions = buildAttributionRecords(callId, normalized.attributions);
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

    const statusCode = operation === 'update' ? 200 : 201;
    return jsonResponse({ callId, attributionIds, operation }, statusCode);
  } catch (error) {
    if (isSalesforceError(error)) {
      const statusCode = mapSalesforceStatus(error.status);
      const detail = error.body ?? error.message ?? 'Salesforce request failed';
      return jsonResponse(
        { error: 'Salesforce error', detail, operation, salesforceStatus: error.status },
        statusCode
      );
    }

    return jsonResponse({ error: 'Unexpected error', detail: String(error), operation }, 500);
  }
}

function isSalesforceError(error) {
  return (
    error instanceof SalesforceError ||
    (error && typeof error === 'object' && 'status' in error && 'body' in error)
  );
}

function mapSalesforceStatus(status) {
  const numeric = Number(status);

  if (Number.isFinite(numeric) && numeric >= 400 && numeric < 600) return numeric;
  if (Number.isFinite(numeric) && numeric >= 300 && numeric < 400) return 502;
  return 500;
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

export { handleRequest, SalesforceError, isSalesforceError };
