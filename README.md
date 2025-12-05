# NoCall Salesforce Webhook Worker

Cloudflare Worker that accepts webhook payloads and inserts records into Salesforce `NoCall_Call__c` and related `NoCall_Attribution__c` objects.

## Deployment

1. Add the following secrets to your Worker (for example with `wrangler secret put`):
   - `SALESFORCE_CLIENT_ID`
   - `SALESFORCE_CLIENT_SECRET`
   - `SALESFORCE_USERNAME`
   - `SALESFORCE_PASSWORD`
   - `SALESFORCE_SECURITY_TOKEN`
   - Optional: `SALESFORCE_LOGIN_URL` (defaults to `https://login.salesforce.com`)
2. Configure `wrangler.toml` with your Worker name.
3. Deploy with `wrangler publish`.

## Expected payload

Send a `POST` request with JSON body:

```json
{
  "call": {
    "Opportunity__c": "...",
    "Contact__c": "...",
    "Status__c": "Planned",
    "Call_Sid__c": "...",
    "Call_Result__c": "Connected",
    "Notes__c": "Sample"
  },
  "attributions": [
    { "label": "source", "value": "ads", "externalId": "abc123" }
  ]
}
```

- `call` is inserted into `NoCall_Call__c`.
- Each attribution item creates `NoCall_Attribution__c` with fields mapped to `Label__c`, `Value__c`, and `External_Id__c` and linked to the created call.

## Response

- **201** on success: `{ "callId": "...", "attributionIds": ["..."] }`
- **400** on validation errors (e.g., missing JSON or `call` object)
- **500** on unexpected errors

## Salesforce API version

The worker currently uses Salesforce REST API version `v58.0`. Adjust `API_VERSION` in `src/index.js` if needed.
