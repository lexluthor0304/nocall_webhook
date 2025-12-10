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

  const payload = { id: 'call-1', callStatus: 'ended', from: '+10000000000', to: '+19999999999' };
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

async function run() {
  await testSalesforceValidationErrorReturnsOriginalStatus();
  console.log('All tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
