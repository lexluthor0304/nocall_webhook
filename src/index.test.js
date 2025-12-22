import assert from 'node:assert/strict';
import { handleRequest } from './index.js';

function createMockResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

async function testSalesforceValidationErrorReturnsOriginalStatus() {
  const originalFetch = global.fetch;
  const mockCalls = [];

  global.fetch = async (url) => {
    mockCalls.push(url);

    if (String(url).includes('/services/oauth2/token')) {
      return createMockResponse({ access_token: 'token', instance_url: 'https://example.salesforce.com' });
    }

    if (String(url).includes('/query')) {
      return createMockResponse({ records: [] });
    }

    if (String(url).includes('sobjects/NoCall_Call__c/')) {
      return createMockResponse({ message: 'Validation Failed: required field missing' }, 400);
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  };

  const payload = {
    id: 'call-1',
    callStatus: 'ended',
    from: '+10000000000',
    to: '+19999999999',
    Normalized_Phone__c: '+19999999999',
  };
  const request = new Request('https://example.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  try {
    const response = await handleRequest(request, {});
    const body = await response.json();

    assert.equal(response.status, 400, 'Webhook should mirror Salesforce validation status');
    assert.equal(body.error, 'Salesforce error');
    assert.equal(body.salesforceStatus, 400);
    assert.ok(
      body.detail?.message?.includes('Validation Failed'),
      'Response should expose Salesforce validation message in detail'
    );
    assert.ok(mockCalls.some((entry) => String(entry).includes('/query')));
  } finally {
    global.fetch = originalFetch;
  }
}

async function testMatchesByNormalizedPhoneBeforeCallRecordId() {
  const originalFetch = global.fetch;
  const mockCalls = [];
  let insertedBody;
  let updatedBody;
  let hasExistingCall = false;

  global.fetch = async (url, options = {}) => {
    mockCalls.push({ url, options });

    if (String(url).includes('/services/oauth2/token')) {
      return createMockResponse({ access_token: 'token', instance_url: 'https://example.salesforce.com' });
    }

    if (String(url).includes('/query')) {
      return hasExistingCall
        ? createMockResponse({ records: [{ Id: 'call-123' }] })
        : createMockResponse({ records: [] });
    }

    if (String(url).includes('sobjects/NoCall_Call__c/') && options.method === 'POST') {
      insertedBody = JSON.parse(options.body);
      hasExistingCall = true;
      return createMockResponse({ id: 'call-123' }, 201);
    }

    if (String(url).includes('sobjects/NoCall_Call__c/') && options.method === 'PATCH') {
      updatedBody = JSON.parse(options.body);
      return createMockResponse({}, 204);
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  };

  const payload = {
    id: 'call-1',
    callStatus: 'ended',
    from: '+10000000000',
    to: '+19999999999',
    Normalized_Phone__c: '+19999999999',
  };
  const request1 = new Request('https://example.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const request2 = new Request('https://example.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, callStatus: 'completed' }),
  });

  try {
    const response1 = await handleRequest(request1, {});
    const body1 = await response1.json();

    assert.equal(response1.status, 201, 'First payload should create a record');
    assert.equal(body1.operation, 'insert');
    assert.equal(insertedBody.Normalized_Phone__c, payload.Normalized_Phone__c);

    const response2 = await handleRequest(request2, {});
    const body2 = await response2.json();

    assert.equal(response2.status, 200, 'Second payload with same normalized phone should update existing record');
    assert.equal(body2.operation, 'update');
    assert.equal(updatedBody.Call_Status__c, 'completed');
    assert.ok(
      mockCalls.some(({ url }) => String(url).includes(`Normalized_Phone__c`)),
      'Query should search by Normalized_Phone__c'
    );
  } finally {
    global.fetch = originalFetch;
  }
}

async function testMissingNormalizedPhoneIsRejectedWhenNoFallback() {
  const request = new Request('https://example.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: '+10000000000' }),
  });

  const response = await handleRequest(request, {});
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, 'Missing required normalized phone for call matching');
}

async function testFallbacksToCallRecordIdWhenToMissing() {
  const originalFetch = global.fetch;
  let insertedBody;

  global.fetch = async (url, options = {}) => {
    if (String(url).includes('/services/oauth2/token')) {
      return createMockResponse({ access_token: 'token', instance_url: 'https://example.salesforce.com' });
    }

    if (String(url).includes('/query')) {
      return createMockResponse({ records: [] });
    }

    if (String(url).includes('sobjects/NoCall_Call__c/') && options.method === 'POST') {
      insertedBody = JSON.parse(options.body);
      return createMockResponse({ id: 'call-abc' }, 201);
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  };

  const request = new Request('https://example.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'call-legacy', callStatus: 'ended' }),
  });

  try {
    const response = await handleRequest(request, {});
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.operation, 'insert');
    assert.equal(insertedBody.CallRecord_Id__c, 'call-legacy');
  } finally {
    global.fetch = originalFetch;
  }
}

async function testSystemMessagesAreOmittedFromConversation() {
  const originalFetch = global.fetch;
  let insertedBody;

  global.fetch = async (url, options = {}) => {
    if (String(url).includes('/services/oauth2/token')) {
      return createMockResponse({ access_token: 'token', instance_url: 'https://example.salesforce.com' });
    }

    if (String(url).includes('/query')) {
      return createMockResponse({ records: [] });
    }

    if (String(url).includes('sobjects/NoCall_Call__c/') && options.method === 'POST') {
      insertedBody = JSON.parse(options.body);
      return createMockResponse({ id: 'call-xyz' }, 201);
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  };

  const payload = {
    Normalized_Phone__c: '+10000000000',
    conversation: {
      messages: [
        { role: 'system', content: 'system prompt text' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'response' },
      ],
    },
  };

  try {
    const request = new Request('https://example.com', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const response = await handleRequest(request, {});
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.operation, 'insert');
    assert.ok(insertedBody.Conversation__c?.includes('user: hello'));
    assert.ok(insertedBody.Conversation__c?.includes('assistant: response'));
    assert.ok(!insertedBody.Conversation__c?.includes('system prompt text'));
  } finally {
    global.fetch = originalFetch;
  }
}

async function run() {
  await testSalesforceValidationErrorReturnsOriginalStatus();
  await testMatchesByNormalizedPhoneBeforeCallRecordId();
  await testMissingNormalizedPhoneIsRejectedWhenNoFallback();
  await testFallbacksToCallRecordIdWhenToMissing();
  await testSystemMessagesAreOmittedFromConversation();
  console.log('All tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
