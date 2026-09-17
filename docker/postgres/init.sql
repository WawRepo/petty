-- Dev-only: creates the two runtime roles with LOGIN. In production, ops creates
-- these roles with real passwords; migrations only GRANT to them (see 0001).
CREATE ROLE petty_api   LOGIN PASSWORD 'petty_api';
CREATE ROLE petty_maint LOGIN PASSWORD 'petty_maint';
