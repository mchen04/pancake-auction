ALTER TABLE draft ADD COLUMN passed_turns integer[] NOT NULL DEFAULT '{}';
ALTER TABLE draft ADD COLUMN completion_reason text
  CHECK (completion_reason IN ('no-eligible-managers', 'full-cycle-passed'));
