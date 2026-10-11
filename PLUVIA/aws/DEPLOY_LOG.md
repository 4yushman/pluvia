# PLUVIA P3 deployment log

A record of the deployment this kit was actually run through, so the claims in `README.md` can be checked against observed output rather than taken on trust.

## What was deployed

| Item | Value |
| --- | --- |
| Date | 11 October 2026 |
| Stack name | `pluvia-p3` |
| Region | `ap-southeast-2` |
| Template | `PLUVIA/aws/template.yaml` from this repository, uploaded through the CloudFormation console |
| Parameter | `AllowedOrigin = http://localhost:8000` |
| Capability | `CAPABILITY_IAM`, for the single scoped Lambda execution role in the template |

The deployment used the browser console only. No CLI session, no CI runner, and no third party tool held credentials for this account at any point.

## Result

`CREATE_COMPLETE` at 11:00:37 IST, 53 seconds after submission at 10:59:44 IST. Nine resources were created and none failed:

| Logical ID | Type |
| --- | --- |
| `HttpApi` | `AWS::ApiGatewayV2::Api` |
| `VerificationIntegration` | `AWS::ApiGatewayV2::Integration` |
| `VerificationRoute` | `AWS::ApiGatewayV2::Route` |
| `VerificationStage` | `AWS::ApiGatewayV2::Stage` |
| `VerificationTable` | `AWS::DynamoDB::Table` |
| `VerificationLogGroup` | `AWS::Logs::LogGroup` |
| `LambdaRole` | `AWS::IAM::Role` |
| `VerificationFunction` | `AWS::Lambda::Function` |
| `ApiInvokePermission` | `AWS::Lambda::Permission` |

## Stack outputs

| Output | Value |
| --- | --- |
| `ApiUrl` | An `execute-api` HTTPS base URL in `ap-southeast-2`. Not reproduced here, because the route is unauthenticated and this repository is public. It is visible in the demo recording, and anyone can create their own by deploying the template. |
| `TableName` | `pluvia-p3-reports` |
| `LogGroupName` | `/aws/lambda/pluvia-p3-verification` |

## Acceptance checks

### 1. Browser submission returns a receipt

`form.html` served from `http://localhost:8000`, submitted with `R1-primary` and `Water visible`. The page reported:

```
Report received as reported evidence. Receipt ID: 69c83988-f6ef-47ee-ba6c-020eb18cf549
```

### 2. An event ID outside the snapshot is rejected

Sent from the browser console on the same page, so the request origin matched `AllowedOrigin`:

```
HTTP 400
{"error":"invalid_event_id"}
```

### 3. The stored item carries only closed-choice fields

A full table scan returned exactly one item. The rejected request wrote nothing.

| Attribute | Value |
| --- | --- |
| `PK` | `EVENT#R1-primary` |
| `SK` | `REPORT#2026-10-11T05:55:00Z#69c83988-f6ef-47ee-ba6c-020eb18cf549` |
| `eventId` | `R1-primary` |
| `observation` | `water_visible` |
| `evidenceType` | `reported` |
| `receivedAt` | `2026-10-11T05:55:00Z` |
| `submissionId` | `69c83988-f6ef-47ee-ba6c-020eb18cf549` |
| `expiresAt` | `1794290100`, which is `2026-11-10T05:55:00Z`, exactly 30 days after receipt |

No name, contact detail, free text, image, IP address, or user agent is stored, because none is collected.

### 4. The log excerpt is sanitized

Both requests appear in the Lambda log group with an outcome code and nothing else:

```
{"requestId":"ea7b4497-4237-4af8-b60f-013104603e36","outcome":"accepted"}
{"requestId":"cf48dd72-5f65-404f-9858-9018c5de439d","outcome":"invalid_event_id"}
```

The submitted event ID and observation do not appear anywhere in the log.

## Measurements

| Metric | Cold invocation | Warm invocation |
| --- | --- | --- |
| Duration | 6010.36 ms | 33.24 ms |
| Billed duration | 6092 ms | 34 ms |
| Init duration | 81.05 ms | not applicable |
| Max memory used | 95 MB of 128 MB | 95 MB of 128 MB |

The configured timeout is 10 seconds, so the cold start fits with room to spare. The cold start is dominated by importing the AWS SDK and resolving credentials on first use; the handler defers that import until a write is needed. Memory headroom is the tighter of the two margins and is the first thing to raise if the handler ever grows.

## Deviations from the first draft of the runbook

Recorded because the published runbook was corrected rather than quietly rewritten.

1. **AWS CloudShell was unavailable.** The account used is managed by an organization whose service control policy denies `cloudshell:CreateEnvironment`. The deployment moved to the CloudFormation console, and the README now documents the console path as the primary runbook with the CLI commands kept as an appendix.
2. **The region was fixed by the hosting account.** The first draft named a different region. The account's console refused it and reported that the project is assigned to `ap-southeast-2`, so the stack was created there. The template needed no change, because it derives every ARN from CloudFormation pseudo parameters.
3. **The predicted rejection body was wrong.** The first draft expected a sentence describing the allowed event IDs. The handler returns the fixed code `{"error":"invalid_event_id"}`. The README now matches the handler, not the other way round.
4. **Origin spelling matters.** The local server prints `http://0.0.0.0:8000`, which is a different browser origin from `http://localhost:8000` and is blocked by CORS. The README now says this explicitly.

## Cost and lifecycle

A small monthly budget with alert thresholds was created before any resource was deployed. The stack is on-demand throughout: an on-demand DynamoDB table, a Lambda billed per invocation, and an HTTP API billed per request. Across the acceptance checks the stack served two requests.

The stack stays up until the event submission is complete, then it is deleted using step 8 of the README. The log group has a 14 day retention policy and is retained on stack deletion on purpose, so the evidence above outlives the stack.
