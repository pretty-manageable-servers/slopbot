CREATE EXTENSION IF NOT EXISTS vector SCHEMA public;
CREATE TABLE IF NOT EXISTS agent_turns (
        sequence BIGSERIAL PRIMARY KEY, id TEXT NOT NULL UNIQUE, server TEXT NOT NULL, message_id TEXT NOT NULL,
        text TEXT NOT NULL, calls TEXT NOT NULL, results TEXT NOT NULL, version BIGINT NOT NULL, valid BIGINT NOT NULL DEFAULT 1
      );
CREATE TABLE IF NOT EXISTS author_directory (server TEXT NOT NULL, author TEXT NOT NULL, names TEXT NOT NULL, bot BIGINT NOT NULL, identity TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(server,author));
CREATE TABLE IF NOT EXISTS context_versions (
        server TEXT NOT NULL, channel TEXT NOT NULL, version BIGINT NOT NULL,
        PRIMARY KEY(server,channel)
      );
CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, message TEXT NOT NULL, content TEXT NOT NULL, created_at BIGINT NOT NULL, result TEXT);
CREATE TABLE IF NOT EXISTS embedding_usage (
        server TEXT NOT NULL, channel TEXT NOT NULL, model TEXT NOT NULL, purpose TEXT NOT NULL,
        requests BIGINT NOT NULL DEFAULT 0, tokens BIGINT NOT NULL DEFAULT 0, unknown_tokens BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY(server,channel,model,purpose)
      );
CREATE TABLE IF NOT EXISTS memory_embeddings (
        server TEXT NOT NULL, memory_id TEXT NOT NULL, model TEXT NOT NULL,
        vector vector NOT NULL, PRIMARY KEY(server,memory_id,model)
      );
CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL, sequence BIGINT NOT NULL,
        kind TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run_id, sequence)
      );
CREATE TABLE IF NOT EXISTS harness_events (
        sequence BIGSERIAL PRIMARY KEY, server TEXT NOT NULL, message_id TEXT NOT NULL,
        state TEXT NOT NULL, event TEXT NOT NULL
      );
CREATE TABLE IF NOT EXISTS jobs (
        sequence BIGSERIAL PRIMARY KEY, id TEXT NOT NULL UNIQUE,
        server TEXT NOT NULL, channel TEXT NOT NULL, message_id TEXT NOT NULL, message TEXT NOT NULL,
        status TEXT NOT NULL, reply TEXT, attempts BIGINT NOT NULL DEFAULT 0, error TEXT, available_at BIGINT NOT NULL DEFAULT 0,
        UNIQUE(server,message_id)
      );
CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, server TEXT NOT NULL, channel TEXT NOT NULL,
        author TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
        created_at BIGINT NOT NULL
      , rowid BIGSERIAL);
CREATE TABLE IF NOT EXISTS memory_sources (
        memory_id TEXT NOT NULL, server TEXT NOT NULL, message_id TEXT NOT NULL,
        PRIMARY KEY(memory_id,message_id)
      );
CREATE TABLE IF NOT EXISTS message_tombstones (
        server TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(server,id)
      );
CREATE TABLE IF NOT EXISTS messages (
        sequence BIGSERIAL PRIMARY KEY,
        server TEXT NOT NULL, id TEXT NOT NULL, channel TEXT NOT NULL,
        body TEXT NOT NULL, UNIQUE(server, id)
      );
CREATE TABLE IF NOT EXISTS profile_current (server TEXT NOT NULL,user_id TEXT NOT NULL,field TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(server,user_id,field));
CREATE TABLE IF NOT EXISTS profile_events (
        id TEXT NOT NULL UNIQUE, server TEXT NOT NULL, user_id TEXT NOT NULL, field TEXT NOT NULL,
        value TEXT NOT NULL, editor TEXT NOT NULL, sources TEXT NOT NULL, valid BIGINT NOT NULL DEFAULT 1,
        sequence BIGSERIAL PRIMARY KEY
      );
CREATE TABLE IF NOT EXISTS profile_locks (server TEXT NOT NULL,user_id TEXT NOT NULL,allow_edits BIGINT NOT NULL,PRIMARY KEY(server,user_id));
CREATE TABLE IF NOT EXISTS run_sources (
        run_id TEXT NOT NULL, server TEXT NOT NULL, message_id TEXT NOT NULL,
        PRIMARY KEY(run_id,message_id)
      );
CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, message TEXT NOT NULL, prompt TEXT NOT NULL,
        status TEXT NOT NULL, result TEXT
      , context_version BIGINT NOT NULL DEFAULT 0, rowid BIGSERIAL);
CREATE TABLE IF NOT EXISTS settings (server TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(server,key));
CREATE TABLE IF NOT EXISTS source_dependents (
        server TEXT NOT NULL, source_id TEXT NOT NULL, output_id TEXT NOT NULL,
        PRIMARY KEY(server,source_id,output_id)
      );
CREATE TABLE IF NOT EXISTS task_checkpoints (
        sequence BIGSERIAL PRIMARY KEY, task_key TEXT NOT NULL, through_sequence BIGINT NOT NULL,
        item TEXT NOT NULL, run_id TEXT NOT NULL, valid BIGINT NOT NULL DEFAULT 1
      );
CREATE TABLE IF NOT EXISTS task_history (
        sequence BIGSERIAL PRIMARY KEY,
        task_key TEXT NOT NULL, item TEXT NOT NULL
      , valid BIGINT NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS task_threads (
        server TEXT NOT NULL, thread TEXT NOT NULL, parent TEXT NOT NULL, source_id TEXT,
        PRIMARY KEY(server, thread)
      );
CREATE TABLE IF NOT EXISTS tool_operations (
        id TEXT PRIMARY KEY, server TEXT NOT NULL, channel TEXT NOT NULL, author TEXT NOT NULL,
        message_id TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at BIGINT NOT NULL
      , resource TEXT);
CREATE TABLE IF NOT EXISTS user_limit_counters (server TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, window_start BIGINT NOT NULL, spent BIGINT NOT NULL, PRIMARY KEY(server,user_id,kind));
CREATE TABLE IF NOT EXISTS user_limit_resets (server TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, count BIGINT NOT NULL, PRIMARY KEY(server,user_id,kind));
CREATE TABLE IF NOT EXISTS reply_runs (server TEXT NOT NULL, message_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(server,message_id,run_id));
CREATE TABLE IF NOT EXISTS conversation_events (
        stream_id BIGSERIAL PRIMARY KEY, server TEXT NOT NULL, channel TEXT NOT NULL,
        kind TEXT NOT NULL, ref TEXT NOT NULL, data TEXT NOT NULL, created_at BIGINT NOT NULL
      );
CREATE INDEX IF NOT EXISTS conversation_events_channel ON conversation_events(server,channel,stream_id);
CREATE INDEX IF NOT EXISTS conversation_events_created ON conversation_events(created_at);
CREATE TABLE IF NOT EXISTS worker_leases (server TEXT PRIMARY KEY, owner TEXT NOT NULL, expires BIGINT NOT NULL);
CREATE OR REPLACE VIEW message_search AS SELECT sequence AS rowid,body::jsonb->>'text' AS text FROM messages;
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(server,status,sequence);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(server,channel,sequence);

CREATE TABLE IF NOT EXISTS app_records (server TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, revision BIGINT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(server,kind,id));

CREATE TABLE IF NOT EXISTS web_webhooks (server TEXT NOT NULL, channel TEXT NOT NULL, webhook_id TEXT NOT NULL, token_encrypted TEXT NOT NULL, PRIMARY KEY(server,channel));
CREATE INDEX IF NOT EXISTS web_webhooks_hook ON web_webhooks(server,webhook_id);
CREATE TABLE IF NOT EXISTS web_replies (id TEXT PRIMARY KEY, server TEXT NOT NULL, channel TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL, message_id TEXT, created_at BIGINT NOT NULL, via TEXT NOT NULL DEFAULT 'webhook');
ALTER TABLE web_replies ADD COLUMN IF NOT EXISTS via TEXT NOT NULL DEFAULT 'webhook';
CREATE INDEX IF NOT EXISTS web_replies_message ON web_replies(server,message_id);

CREATE INDEX IF NOT EXISTS messages_fulltext ON messages USING gin(to_tsvector('simple',body::jsonb->>'text'));

CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, server TEXT NOT NULL, channel TEXT NOT NULL, created_by TEXT NOT NULL, created_at BIGINT NOT NULL, revoked_at BIGINT, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS shares_server ON shares(server,created_at);
CREATE TABLE IF NOT EXISTS web_sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, csrf TEXT NOT NULL, expires BIGINT NOT NULL, created BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS web_sessions_expires ON web_sessions(expires);
CREATE TABLE IF NOT EXISTS web_chats (id TEXT PRIMARY KEY, server TEXT NOT NULL, owner TEXT NOT NULL, title TEXT NOT NULL, created BIGINT NOT NULL, updated BIGINT NOT NULL, deleted BIGINT NOT NULL DEFAULT 0);
ALTER TABLE web_chats ADD COLUMN IF NOT EXISTS effort TEXT;
CREATE INDEX IF NOT EXISTS web_chats_owner ON web_chats(server,owner,updated);

-- Remove legacy chat vectors only in this schema; chat history stays in messages.
DO $$ BEGIN
  EXECUTE format('DROP TABLE IF EXISTS %I.embeddings', current_schema());
END $$;
DELETE FROM embedding_usage WHERE purpose IN ('index','query');
