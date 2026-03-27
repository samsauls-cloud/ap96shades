ALTER TABLE po_receiving_sessions
  ADD COLUMN IF NOT EXISTS parent_session_id uuid REFERENCES po_receiving_sessions(id),
  ADD COLUMN IF NOT EXISTS child_session_ids uuid[] DEFAULT '{}';
