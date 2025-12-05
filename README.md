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

### 1) Direct Salesforce shape (existing behavior)

Send `call` and optional `attributions` already shaped like Salesforce fields:

```json
{
  "call": {
    "Call_Status__c": "completed",
    "CallRecord_Id__c": "1",
    "From_Phone__c": "+815012345678",
    "To_Phone__c": "+819098765432",
    "Conversation__c": "free text...",
    "Notes__c": "operator memo"
  },
  "attributions": [
    { "label": "source", "value": "ads", "externalId": "abc123" }
  ]
}
```

### 2) NoCall console shape (automatically normalized)

You can also send the webhook body exactly as emitted by NoCall; it will be mapped for you:

```json
{
  "id": "1",
  "timestamp": "2025-03-28T15:45:05.240+09:00",
  "callStatus": "completed",
  "from": "+815012345678",
  "to": "+819098765432",
  "detailsUrl": "https://example.com/console/call-history/1",
  "endUser": {
    "id": "1",
    "phoneNumber": "+819012345678",
    "attributions": {
      "姓": "山田",
      "名": "太郎"
    }
  },
  "conversation": {
    "startTime": "2025-03-28T15:40:05.240+09:00",
    "endTime": "2025-03-28T15:45:05.240+09:00",
    "duration": 300,
    "message": [
      { "role": "system", "content": "system message" },
      { "role": "assistant", "content": "assistant message" },
      { "role": "user", "content": "user message" },
      {
        "role": "assistant_tool_call",
        "tool_calls": [
          {
            "id": "tool_call_123",
            "name": "tool name",
            "args": { "arg1": "value1" }
          }
        ]
      },
      {
        "role": "tool",
        "content": "tool result",
        "name": "tool name",
        "tool_call_id": "tool_call_123"
      }
    ],
    "goalStatus": "achieved",
    "goalResult": "成功しました。"
  },
  "agent": {
    "id": 1,
    "name": "agent1"
  }
}
```

### Mapping applied automatically

The worker converts the NoCall-shaped payload above into the following Salesforce fields:

| Source | Salesforce field |
| --- | --- |
| `id` | `CallRecord_Id__c` |
| `callStatus` | `Call_Status__c` |
| `from` | `From_Phone__c` |
| `to` | `To_Phone__c` |
| `detailsUrl` | `Recording_Url__c` (stored as a link) |
| `endUser.id` | `EndUser_Id__c` |
| `endUser.phoneNumber` | `EndUser_Phone__c` |
| `conversation.startTime` | `Dialed_At__c` |
| `conversation.endTime` | `Ended_At__c` |
| `conversation.duration` | `Duration_Sec__c` (stringified) |
| `conversation.goalStatus` | `Goal_Status__c` |
| `conversation.goalResult` | `Goal_Result__c` |
| `conversation.message` array | `Conversation__c` (flattened text with tool calls preserved) |
| `agent.name` / `agent.id` | `Triggered_By_Label__c` |
| `endUser.attributions` object | array of `Label__c` / `Value__c` rows in `NoCall_Attribution__c` |

`call` is inserted into `NoCall_Call__c`. Each attribution item creates `NoCall_Attribution__c` with fields mapped to `Label__c`, `Value__c`, and `External_Id__c` and linked to the created call. `message` is automatically copied to `Conversation__c` and `notes` to `Notes__c` when you send the direct Salesforce shape; you can also send these API names directly if you prefer.

## Response

- **201** on success: `{ "callId": "...", "attributionIds": ["..."] }`
- **400** on validation errors (e.g., missing JSON or `call` object)
- **500** on unexpected errors

## Salesforce API version

The worker currently uses Salesforce REST API version `v58.0`. Adjust `API_VERSION` in `src/index.js` if needed.
