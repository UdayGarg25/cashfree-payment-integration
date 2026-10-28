-- Enable pgcrypto extension for UUID generation if not already enabled
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Payments Table Definition
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id VARCHAR(100) NOT NULL UNIQUE,
    student_id VARCHAR(100) NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'INR' NOT NULL,
    status VARCHAR(50) DEFAULT 'CREATED' NOT NULL,
    cashfree_order_id VARCHAR(100) UNIQUE,
    cashfree_payment_id VARCHAR(100),
    payment_session_id VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,

    -- Constraints
    CONSTRAINT chk_payments_amount CHECK (amount > 0),
    CONSTRAINT chk_payments_status CHECK (status IN ('CREATED', 'PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REQUIRES_RECONCILIATION'))
);

-- Safely expand status column size and update constraint on existing databases
DO $$
BEGIN
    ALTER TABLE payments ALTER COLUMN status TYPE VARCHAR(50);
    ALTER TABLE payments DROP CONSTRAINT IF EXISTS chk_payments_status;
    ALTER TABLE payments ADD CONSTRAINT chk_payments_status CHECK (status IN ('CREATED', 'PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REQUIRES_RECONCILIATION'));
EXCEPTION
    WHEN undefined_table THEN
        NULL;
END $$;

-- Indexes for performance optimization on payments
CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments (order_id);
CREATE INDEX IF NOT EXISTS idx_payments_student_id ON payments (student_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);
CREATE INDEX IF NOT EXISTS idx_payments_cashfree_order_id ON payments (cashfree_order_id);

-- Webhook Events Table for Idempotency and Audit Logging
CREATE TABLE IF NOT EXISTS webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id VARCHAR(255) UNIQUE NOT NULL,
    order_id VARCHAR(100),
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    received_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Indexes for performance optimization on webhook_events
CREATE INDEX IF NOT EXISTS idx_webhook_events_order_id ON webhook_events (order_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_event_id ON webhook_events (event_id);

-- Function to update the updated_at timestamp automatically
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to execute update_updated_at_column on payments update (idempotent DO block)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_payments_updated_at'
    ) THEN
        CREATE TRIGGER trg_payments_updated_at
        BEFORE UPDATE ON payments
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;
