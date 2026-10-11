# PLUVIA AWS intake kit

This kit accepts a small, closed-choice report for one event in the frozen snapshot. A submitted choice is stored as **reported evidence**; it is not independently verified. The kit does not collect names, contact details, free text, or images, and it does not infer site conditions.

The template creates one API Gateway HTTP API with `POST /verifications`, one Python Lambda, one on-demand DynamoDB table, and one Lambda CloudWatch log group. The Lambda role can only write items to that table and create/write streams in that log group. The API has a 10-request/second rate limit and a burst limit of 20; Lambda reserved concurrency is 5. The table expires reports after 30 days using DynamoDB TTL. The log group retains logs for 14 days. The allowlist is `R1-primary`, `R2`, `R3`, and `backup`; the backup candidate has no stored replay profile in the snapshot. No replay profile is fabricated for it.

`handler.py` is the readable handler source. The same source is embedded in `template.yaml` as `Code.ZipFile`, allowing `aws cloudformation deploy` to package the single-file Python function without an artifact bucket or another service. Keep the two copies identical when changing the handler. The template's Lambda code accepts exactly `eventId` and `observation`, checks both against closed allowlists, and logs only a Lambda request ID and an outcome code. It never logs the request body or exception text.

`form.html` contains only two select controls and a visible response status. Serve it from an HTTP(S) origin and configure that exact origin at deployment. Opening it with `file://` is disabled. The separate P2 file-picker demo remains offline and read-only. The route is unauthenticated (`AuthorizationType: NONE`); anyone with the endpoint can submit only the two allowlisted values, and the rate/concurrency settings do not authenticate callers.

The template is region neutral. It derives every ARN from the CloudFormation pseudo parameters, so it deploys unchanged in any commercial region that offers API Gateway HTTP APIs, Lambda, and DynamoDB. `DEPLOY_LOG.md` records the region, outputs, and measurements of the deployment that was actually run.

## Console runbook

This is the path used for the recorded deployment. It needs only a browser and an identity that can create the stack. Steps 4 to 7 are the acceptance checks.

### 1. Get the files

```bash
git clone https://github.com/4yushman/pluvia.git
cd pluvia/PLUVIA/aws
```

### 2. Choose the form origin

Decide the exact origin from which a browser will load `form.html`. The origin is the scheme, hostname, and optional port only: no path, trailing slash, wildcard, or credentials. The parameter has no default, so the stack cannot be created with an empty or wildcard origin by accident.

For a local demo served by step 4, the origin is:

```
http://localhost:8000
```

`http://127.0.0.1:8000` and `http://0.0.0.0:8000` are different origins to a browser and will be rejected by CORS if they were not the configured value. Use the same spelling in the browser address bar as in the parameter.

### 3. Create the stack

1. Open the CloudFormation console in the region you intend to use and confirm the region in the page URL.
2. Choose **Create stack**, then **With new resources (standard)**.
3. Keep **Choose an existing template**, pick **Upload a template file**, and upload `template.yaml`.
4. Set the stack name to `pluvia-p3` and set **AllowedOrigin** to the origin from step 2.
5. Leave the stack options at their defaults. Acknowledge that the stack creates IAM resources; the template creates one scoped Lambda execution role.
6. Submit and wait for **CREATE_COMPLETE**. Nine resources are created.
7. Open the **Outputs** tab and copy `ApiUrl`, `TableName`, and `LogGroupName`.

`ApiUrl` is the API base URL. Append `/verifications` for submissions. The stage is `$default`, so no stage name appears in the path. The base URL is an endpoint, not a secret, but it is unauthenticated, so do not publish it where it will attract unrelated traffic.

### 4. Serve the form and submit one report

From the `PLUVIA/aws` directory, serve the kit on the port used in the origin:

```bash
python3 -m http.server 8000
```

Build the form URL by appending the API base URL as a URL-encoded `api` query parameter:

```bash
python3 -c 'import sys, urllib.parse; print("http://localhost:8000/form.html?api=" + urllib.parse.quote(sys.argv[1], safe=""))' 'PASTE_API_URL_HERE'
```

Open the printed URL in a browser. The status line reads `Ready.` and the submit button becomes active only when the `api` parameter is a valid HTTPS base URL. Choose `R1-primary` and `Water visible`, then submit.

Expected status line:

```
Report received as reported evidence. Receipt ID: <uuid>
```

That receipt is the HTTP `201` body field `submissionId`. The full body is:

```json
{"status":"received","evidenceType":"reported","receivedAt":"<ISO-8601 Z>","submissionId":"<uuid>"}
```

### 5. Confirm the rejection path

In the browser console on the same page, send an event ID that is not in the snapshot allowlist. Running it from that page keeps the request origin identical to `AllowedOrigin`.

```js
fetch('PASTE_API_URL_HERE/verifications', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ eventId: 'not-in-snapshot', observation: 'water_visible' })
}).then(r => { console.log('HTTP', r.status); return r.json(); })
  .then(j => console.log(JSON.stringify(j)));
```

Expected output, and no new table item:

```
HTTP 400
{"error":"invalid_event_id"}
```

The other rejection codes are `invalid_request` for a malformed body or unexpected keys, and `invalid_observation` for an observation outside the closed list.

### 6. Read back the stored report

Open the DynamoDB console, choose **Explore items**, select the table from `TableName`, and run a scan. The valid submission from step 4 is the only item; the rejected request in step 5 writes nothing.

The stored key format is `PK=EVENT#eventId` and `SK=REPORT#receivedAt#submissionId`. The item carries only `eventId`, `observation`, `evidenceType`, `receivedAt`, `submissionId`, and `expiresAt`. TTL expiry is asynchronous and is set to 30 days after receipt.

### 7. Read a sanitized log excerpt

Open the CloudWatch console, go to **Log groups**, open the group from `LogGroupName`, and open the newest log stream. The handler writes one line per request:

```
{"requestId":"<lambda request id>","outcome":"accepted"}
{"requestId":"<lambda request id>","outcome":"invalid_event_id"}
```

No submitted value, event ID, observation, or exception text appears in the log. The surrounding `INIT_START`, `START`, `END`, and `REPORT` lines are written by the Lambda runtime.

### 8. Tear down the test stack

In the CloudFormation console, select the stack and choose **Delete stack**. Deleting the stack also deletes its DynamoDB table and any smoke-test reports in it. The log group is retained on purpose so that the evidence survives the stack; delete it separately in the CloudWatch console when it is no longer needed.

## AWS CLI equivalents

These commands do the same work as the console runbook for anyone with CLI access. Set the region once:

```bash
export AWS_REGION='ap-southeast-2'
aws sts get-caller-identity --region "$AWS_REGION"
```

Deploy:

```bash
export ALLOWED_ORIGIN='http://localhost:8000'

aws cloudformation deploy \
  --region "$AWS_REGION" \
  --stack-name pluvia-p3 \
  --template-file template.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides AllowedOrigin="$ALLOWED_ORIGIN"
```

Read the outputs:

```bash
API_URL="$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name pluvia-p3 \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue | [0]" \
  --output text)"
TABLE_NAME="$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name pluvia-p3 \
  --query "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue | [0]" \
  --output text)"
LOG_GROUP="$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name pluvia-p3 \
  --query "Stacks[0].Outputs[?OutputKey=='LogGroupName'].OutputValue | [0]" \
  --output text)"
printf 'API_URL=%s\nTABLE_NAME=%s\nLOG_GROUP=%s\n' "$API_URL" "$TABLE_NAME" "$LOG_GROUP"
```

Valid and invalid smoke tests. `curl` does not exercise browser CORS, so these check the handler only:

```bash
curl --silent --show-error --write-out '\nHTTP %{http_code}\n' \
  --request POST \
  --header 'content-type: application/json' \
  --data '{"eventId":"R1-primary","observation":"water_visible"}' \
  "$API_URL/verifications"

curl --silent --show-error --write-out '\nHTTP %{http_code}\n' \
  --request POST \
  --header 'content-type: application/json' \
  --data '{"eventId":"not-in-snapshot","observation":"not_sure"}' \
  "$API_URL/verifications"
```

Read back the stored report. The scan is for verification of this small test stack, not a production query pattern:

```bash
aws dynamodb scan \
  --region "$AWS_REGION" \
  --table-name "$TABLE_NAME" \
  --filter-expression '#eventId = :event' \
  --expression-attribute-names '{"#pk":"PK","#sk":"SK","#eventId":"eventId","#observation":"observation","#evidence":"evidenceType","#received":"receivedAt","#expires":"expiresAt"}' \
  --expression-attribute-values '{":event":{"S":"R1-primary"}}' \
  --projection-expression '#pk, #sk, #eventId, #observation, #evidence, #received, #expires' \
  --output json
```

Read the sanitized log excerpt. If the newest stream is not visible immediately, rerun the stream lookup after a short pause:

```bash
LOG_STREAM="$(aws logs describe-log-streams \
  --region "$AWS_REGION" \
  --log-group-name "$LOG_GROUP" \
  --order-by LastEventTime \
  --descending \
  --limit 1 \
  --query 'logStreams[0].logStreamName' \
  --output text)"
aws logs get-log-events \
  --region "$AWS_REGION" \
  --log-group-name "$LOG_GROUP" \
  --log-stream-name "$LOG_STREAM" \
  --limit 10 \
  --query 'events[].message' \
  --output text
```

Tear down:

```bash
aws cloudformation delete-stack --region "$AWS_REGION" --stack-name pluvia-p3
aws cloudformation wait stack-delete-complete --region "$AWS_REGION" --stack-name pluvia-p3
```
