-- ============================================================
-- Audit Log Schema for Avise
-- Tracks all sensitive actions for compliance and security
-- ============================================================

-- Create AuditLog table
CREATE TABLE IF NOT EXISTS "AuditLog" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who performed the action
  "userId" UUID REFERENCES "User"(id) ON DELETE SET NULL,
  "userEmail" TEXT,
  "userRole" TEXT,

  -- What action was performed
  action TEXT NOT NULL CHECK (action IN (
    -- Authentication
    'LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'PASSWORD_RESET', 'PASSWORD_CHANGED',

    -- Deal operations
    'DEAL_CREATED', 'DEAL_UPDATED', 'DEAL_DELETED', 'DEAL_VIEWED',
    'DEAL_STAGE_CHANGED', 'DEAL_ASSIGNED', 'DEAL_EXPORTED',

    -- Document operations
    'DOCUMENT_UPLOADED', 'DOCUMENT_DELETED', 'DOCUMENT_DOWNLOADED',
    'DOCUMENT_VIEWED',

    -- Memo operations
    'MEMO_CREATED', 'MEMO_UPDATED', 'MEMO_DELETED', 'MEMO_APPROVED',
    'MEMO_EXPORTED', 'MEMO_SHARED',

    -- User management
    'USER_CREATED', 'USER_UPDATED', 'USER_DELETED', 'USER_INVITED',
    'USER_ROLE_CHANGED',

    -- AI operations
    'AI_CHAT', 'AI_GENERATE', 'AI_INGEST',

    -- System operations
    'SETTINGS_CHANGED', 'BULK_EXPORT', 'API_KEY_CREATED', 'API_KEY_REVOKED'
  )),

  -- What resource was affected
  "resourceType" TEXT CHECK ("resourceType" IN (
    'DEAL', 'DOCUMENT', 'MEMO', 'USER', 'COMPANY', 'FOLDER', 'SETTINGS', 'API_KEY'
  )),
  "resourceId" UUID,
  "resourceName" TEXT,

  -- Additional context
  description TEXT,
  metadata JSONB DEFAULT '{}',

  -- Request info for forensics
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "requestId" TEXT,

  -- Severity level
  severity TEXT DEFAULT 'INFO' CHECK (severity IN ('INFO', 'WARNING', 'ERROR', 'CRITICAL')),

  -- Timestamps
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- Indexes for performance
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_auditlog_userid ON "AuditLog"("userId");
CREATE INDEX IF NOT EXISTS idx_auditlog_action ON "AuditLog"(action);
CREATE INDEX IF NOT EXISTS idx_auditlog_resourcetype ON "AuditLog"("resourceType");
CREATE INDEX IF NOT EXISTS idx_auditlog_resourceid ON "AuditLog"("resourceId");
CREATE INDEX IF NOT EXISTS idx_auditlog_createdat ON "AuditLog"("createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_auditlog_severity ON "AuditLog"(severity);

-- Composite index for common queries
CREATE INDEX IF NOT EXISTS idx_auditlog_user_action ON "AuditLog"("userId", action);
CREATE INDEX IF NOT EXISTS idx_auditlog_resource ON "AuditLog"("resourceType", "resourceId");

-- ============================================================
-- Row Level Security
-- ============================================================

ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;

-- Only admins can view audit logs
CREATE POLICY "Admins can view audit logs" ON "AuditLog"
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM "User"
            WHERE "User".id = auth.uid()
            AND "User".role IN ('ADMIN', 'PARTNER')
        )
    );

-- System can insert audit logs (no auth required for logging)
CREATE POLICY "System can insert audit logs" ON "AuditLog"
    FOR INSERT
    WITH CHECK (true);

-- No updates or deletes allowed (audit logs are immutable)
-- This is enforced by not having UPDATE or DELETE policies

-- ============================================================
-- Retention function (optional - run periodically)
-- ============================================================

-- Function to delete old audit logs (keep 2 years by default)
CREATE OR REPLACE FUNCTION cleanup_old_audit_logs(retention_days INTEGER DEFAULT 730)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM "AuditLog"
    WHERE "createdAt" < NOW() - (retention_days || ' days')::INTERVAL;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Example queries for audit reports
-- ============================================================

-- Recent activity for a specific user
-- SELECT * FROM "AuditLog" WHERE "userId" = 'user-uuid' ORDER BY "createdAt" DESC LIMIT 50;

-- All deal deletions in the last 30 days
-- SELECT * FROM "AuditLog" WHERE action = 'DEAL_DELETED' AND "createdAt" > NOW() - INTERVAL '30 days';

-- Failed login attempts
-- SELECT * FROM "AuditLog" WHERE action = 'LOGIN_FAILED' ORDER BY "createdAt" DESC;

-- Activity summary by user
-- SELECT "userEmail", COUNT(*) as action_count FROM "AuditLog" GROUP BY "userEmail" ORDER BY action_count DESC;
