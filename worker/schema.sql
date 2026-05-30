-- Live session tracking (independent of biliLive-tools recording)
CREATE TABLE IF NOT EXISTS live_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  live_id TEXT,
  start_time INTEGER NOT NULL,  -- epoch ms (first detection time, ≤2min accuracy)
  end_time INTEGER,             -- epoch ms, NULL = ongoing
  UNIQUE(room_id, platform, live_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_room ON live_sessions(room_id, platform, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_time ON live_sessions(start_time DESC);
