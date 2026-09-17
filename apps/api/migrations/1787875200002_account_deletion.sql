-- Up Migration
-- Account deletion (Phase 12): the request role clears the user's own encrypted document.
GRANT DELETE ON user_docs TO petty_api;

-- Down Migration
REVOKE DELETE ON user_docs FROM petty_api;
