# Cashfree Payment Integration (University Management System - UMS/ERP)

Production-ready backend payment integration service for a University Management System (UMS/ERP) using **Cashfree Payment Gateway Sandbox**, **Node.js**, **Express.js**, and **PostgreSQL**.

---

## Architecture Overview

```text
Student/ERP Client
       │
       ▼
[Express Server] ──(Validates input)──► [PostgreSQL] (Persists 'CREATED')
       │
       ├──────────────────────────────► [Cashfree PG API] (/pg/orders)
       ▼
(Saves paymentSessionId & updates to 'PENDING' / 'REQUIRES_RECONCILIATION')
       │
       ├──────► [Webhook Listener] ◄──── [Cashfree Gateway Notifications]
       │        (Verifies HMAC-SHA256, deduplicates via webhook_events,
       │         updates status to 'PAID' or 'FAILED')
       │
       └──────► [Status Reconciler] ───► [Cashfree GET /orders/:orderId]
```

### Key Architectural Safeguards:
1. **Never Trust the Client**: Merchant order IDs, customer IDs, and status values are generated and verified strictly on the backend.
2. **Deterministic State Machine**: Orders transition across `CREATED` -> `PENDING` -> `PAID` / `FAILED` / `CANCELLED` / `REQUIRES_RECONCILIATION`.
3. **Downgrade Prevention**: A confirmed `PAID` order can **never** be downgraded by an out-of-order or late failure event.
4. **Idempotency & Deduplication**: Webhooks are recorded in `webhook_events` with unique event hashes. Duplicate deliveries are acknowledged with HTTP 200 without duplicate processing.
5. **Row-Level Transaction Locking**: Status updates lock payment records (`SELECT ... FOR UPDATE`) to prevent race conditions between webhooks and polling queries.
6. **Ambiguous Outcome Recovery**: Network timeouts or 504 gateway failures during order creation transition the record to `REQUIRES_RECONCILIATION` instead of prematurely marking it permanently failed. Subsequent status queries or webhooks automatically reconcile the order.
7. **Zero Secret Leakage**: Credentials and secret keys are loaded via environment variables and never logged or exposed in client responses.

---

## Tech Stack
- **Runtime:** Node.js (v18+, CommonJS)
- **Framework:** Express.js
- **Database:** PostgreSQL (`pg` connection pool with SSL/SCRAM support)
- **Payment Provider:** Cashfree Payment Gateway (API v2023-08-01 / v2025-01-01 Sandbox)
- **Testing:** Node.js Built-in Test Runner (`node:test`, `node:assert`)

---

## Project Structure
```text
cashfree-payment-integration/
├── src/
│   ├── config/
│   │   ├── db.js                # PostgreSQL connection pool and health checks
│   │   ├── schema.sql           # Database tables (payments, webhook_events), indexes, triggers
│   │   └── setup.js             # Automated database creation and migration script
│   ├── controllers/
│   │   └── paymentController.js # Handlers for payment creation, status check, and webhooks
│   ├── routes/
│   │   ├── paymentRoutes.js     # Routes for /api/payments
│   │   └── webhookRoutes.js     # Routes for /api/webhooks
│   ├── services/
│   │   ├── paymentService.js    # Core transactional payment lifecycle & state machine
│   │   └── cashfreeService.js   # Cashfree HTTP client & HMAC-SHA256 signature verification
│   ├── middleware/
│   │   └── validatePayment.js   # Strict input validation for payment initiation
│   ├── utils/
│   │   └── orderGenerator.js    # Merchant order ID and customer ID generators
│   └── app.js                   # Express application setup & rawBody preservation
├── tests/
│   ├── unit/
│   │   ├── orderGenerator.test.js   # ID generation tests
│   │   ├── validation.test.js       # Payload validation tests
│   │   └── cashfreeService.test.js  # Cashfree gateway client & signature tests
│   └── integration/
│       └── payments.test.js         # 28-scenario comprehensive integration test suite
├── .env.example                 # Template for required environment variables
├── .gitignore                   # Excludes .env, node_modules, and logs
├── package.json                 # Project configuration & npm scripts
└── README.md                    # System documentation
```

---

## Setup Instructions

### 1. Prerequisites
- **Node.js**: v18.0.0 or higher
- **PostgreSQL**: v13+ running locally or in Docker
- **Cashfree Sandbox Account**: API Keys from [Cashfree Merchant Dashboard](https://merchant.cashfree.com/)

### 2. Install Dependencies
```bash
npm install
```

### 3. Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
*(On Windows PowerShell: `Copy-Item .env.example .env`)*

Configure your `.env` file:
```env
PORT=5000
NODE_ENV=development

# PostgreSQL Database Configuration
DB_HOST=localhost
DB_PORT=5432
DB_NAME=ums_payment_db
DB_USER=postgres
DB_PASSWORD=your_postgres_password

# Cashfree Sandbox Credentials
CASHFREE_APP_ID=your_sandbox_app_id
CASHFREE_SECRET_KEY=your_sandbox_secret_key
CASHFREE_API_VERSION=2023-08-01
CASHFREE_ENV=SANDBOX
```

### 4. Initialize Database Schema
Run the database setup script. If `ums_payment_db` does not exist, the script connects to PostgreSQL's maintenance database and creates it automatically before applying `schema.sql`:
```bash
npm run db:setup
```

### 5. Running the Application
```bash
# Development mode (auto-reload via nodemon)
npm run dev

# Production mode
npm start
```

---

## Payment State Machine & Lifecycle

| Internal Status | Description | Allowable Next States |
| :--- | :--- | :--- |
| `CREATED` | Initial record persisted in database prior to external gateway call | `PENDING`, `REQUIRES_RECONCILIATION`, `FAILED` |
| `PENDING` | Order created in Cashfree Sandbox; awaiting user payment authorization | `PAID`, `FAILED`, `CANCELLED` |
| `PAID` | Terminal success state; confirmed via Cashfree API or verified webhook | *None (Terminal - strictly protected from downgrade)* |
| `FAILED` | Gateway rejected or payment attempt definitively failed | `PAID` *(only if customer retried & completed payment)* |
| `CANCELLED` | Payment aborted by user or session terminated by gateway | `PAID` *(only if customer completed recovery)* |
| `REQUIRES_RECONCILIATION` | Gateway call timed out or network glitched; true status unknown | `PENDING`, `PAID`, `FAILED` *(resolved on subsequent check/webhook)* |

---

## API Endpoints

### 1. System Health Checks
- **`GET /health`**: Verifies web server is running.
- **`GET /health/db`**: Verifies PostgreSQL pool connection and server clock.

---

### 2. Create Payment Order
- **Endpoint:** `POST /api/payments`
- **Description:** Creates an order record in PostgreSQL (`CREATED`), registers it with Cashfree Sandbox (`/pg/orders`), updates state to `PENDING` (or `REQUIRES_RECONCILIATION` on timeout), and returns `paymentSessionId` for frontend checkout integration.

#### Request Headers:
```http
Content-Type: application/json
```

#### Request Body:
```json
{
  "studentId": "STU2026001",
  "amount": 1500.00,
  "currency": "INR",
  "customerName": "Rohan Sharma",
  "customerEmail": "rohan.sharma@example.com",
  "customerPhone": "9876543210"
}
```

#### Response (`201 Created`):
```json
{
  "status": "SUCCESS",
  "message": "Payment order created successfully",
  "data": {
    "orderId": "order_UMS_1793199238684_18c70b38",
    "status": "PENDING",
    "paymentSessionId": "session_cKu1X9ElGaUp...",
    "cfOrderId": "1468982997516550656",
    "amount": 1500,
    "currency": "INR",
    "createdAt": "2026-10-28T14:53:58.000Z"
  }
}
```

---

### 3. Payment Status Retrieval & Reconciliation
- **Endpoint:** `GET /api/payments/:orderId`
- **Description:** Retrieves the local payment record and reconciles against Cashfree Sandbox if still `PENDING` or `REQUIRES_RECONCILIATION`. If already `PAID`, returns confirmed state immediately without downgrading. If gateway is temporarily unavailable, returns current local record without failing.

#### Example Request:
```bash
curl http://localhost:5000/api/payments/order_UMS_1793199238684_18c70b38
```

#### Response (`200 OK`):
```json
{
  "status": "SUCCESS",
  "data": {
    "orderId": "order_UMS_1793199238684_18c70b38",
    "studentId": "STU2026001",
    "amount": 1500,
    "currency": "INR",
    "status": "PAID",
    "cashfreeOrderId": "1468982997516550656",
    "cashfreePaymentId": "9988112233",
    "paymentSessionId": "session_cKu1X9ElGaUp...",
    "createdAt": "2026-10-28T14:53:58.000Z",
    "updatedAt": "2026-10-28T14:54:10.000Z"
  }
}
```

---

### 4. Cashfree Webhook Processing
- **Endpoint:** `POST /api/webhooks/cashfree`
- **Headers Required:**
  - `x-webhook-signature`: HMAC-SHA256 signature generated by Cashfree
  - `x-webhook-timestamp`: Webhook dispatch timestamp
  - `Content-Type: application/json`

#### Signature Verification:
$$\text{Expected Signature} = \text{Base64}\left(\text{HMAC-SHA256}\left(\text{timestamp} + \text{rawBody}, \text{CASHFREE\_SECRET\_KEY}\right)\right)$$
Verified in constant time with `crypto.timingSafeEqual`.

#### Supported Webhook Events:
- `PAYMENT_SUCCESS_WEBHOOK` -> Updates status to `PAID`, records `cashfree_payment_id`.
- `PAYMENT_FAILED_WEBHOOK` -> Updates status to `FAILED` (ignored if already `PAID`).
- `PAYMENT_USER_DROPPED_WEBHOOK` -> Updates status to `CANCELLED` (ignored if already `PAID`).

---

## Testing

### Automated Test Suite
The project includes a comprehensive suite of 43 unit and integration tests using Node's native test runner (`node:test`). Tests run against mock gateway fixtures so they execute fast and reliably without consuming sandbox limits or exposing secrets:

```bash
npm test
```

#### Test Coverage Summary:
- **Validation and Payment Creation (Tests 1-8)**: Valid payload, missing fields, invalid email/phone, boundary amounts, Cashfree success, API error (502), timeout recovery (`REQUIRES_RECONCILIATION`), server ID uniqueness.
- **Status Reconciliation (Tests 9-16)**: Existing lookup, 404 unknown order, successful confirmation (`PAID`), active pending, expired (`FAILED`), terminated (`CANCELLED`), gateway unavailable fallback, delayed conflicting response protection.
- **Webhooks (Tests 17-28)**: Valid signature (200), invalid signature (401), missing signature headers (401), malformed payload (400), payment success (`PAID`), payment failed (`FAILED`), unsupported event acknowledgment, duplicate delivery idempotency, unknown order ID (404), amount/currency mismatch (400), transaction rollback consistency, out-of-order downgrade prevention.
- **Unit Suites (15 tests)**: Order ID generator, customer ID sanitization, validation middleware, Cashfree client headers/timeouts, HMAC signature verification.

---

## Real Cashfree Sandbox Live Verification

To execute a live end-to-end check with your configured Cashfree Sandbox credentials:
1. Ensure your `.env` contains valid Sandbox credentials:
   ```env
   CASHFREE_APP_ID=your_sandbox_app_id
   CASHFREE_SECRET_KEY=your_sandbox_secret_key
   CASHFREE_API_VERSION=2023-08-01
   CASHFREE_ENV=SANDBOX
   ```
2. Start the development server:
   ```bash
   npm run dev
   ```
3. Send a test payment initiation request:
   ```bash
   curl -X POST http://localhost:5000/api/payments \
     -H "Content-Type: application/json" \
     -d '{
       "studentId": "STU2026001",
       "amount": 1500.00,
       "currency": "INR",
       "customerName": "Rohan Sharma",
       "customerEmail": "rohan.sharma@example.com",
       "customerPhone": "9876543210"
     }'
   ```
4. Query the payment status using the returned `orderId`:
   ```bash
   curl http://localhost:5000/api/payments/<returned_orderId>
   ```

---

## Local Webhook Testing via Tunnel (e.g., ngrok)

To receive live asynchronous webhooks from Cashfree during local development:
1. Start your local server on port 5000:
   ```bash
   npm run dev
   ```
2. Start an HTTPS tunnel:
   ```bash
   ngrok http 5000
   ```
3. In your [Cashfree Merchant Dashboard](https://merchant.cashfree.com/) -> **Developers** -> **Webhooks**:
   - Set Webhook URL: `https://<subdomain>.ngrok-free.app/api/webhooks/cashfree`
   - Select version: `2023-08-01`
   - Subscribe to Payment Events (`PAYMENT_SUCCESS_WEBHOOK`, `PAYMENT_FAILED_WEBHOOK`, `PAYMENT_USER_DROPPED_WEBHOOK`).
#   c a s h f r e e - p a y m e n t - i n t e g r a t i o n  
 