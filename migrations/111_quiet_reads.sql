-- Two reads a big club (big_club.test.ts: two years, 600,000 changes) still made through a whole table.

-- A person's receipts on their page in the staff app: theirs, and the ones for a kid a parent paid for. 049's index
-- is for the first; the second read every receipt the club ever made, about 80 ms a page.
CREATE INDEX IF NOT EXISTS receipt_for_person ON receipt (for_person_id, created_at DESC) WHERE for_person_id IS NOT NULL;

-- The hourly tidy takes what actions forget (an upload's file, a reason typed in a chat report or stop) out of runs
-- that will never be applied (forgetStaleInputs, actions.ts), and an account deletion takes the person's reasons out
-- of theirs (eraseChats, chat.ts): each read every change the club ever made, about 470 ms an hour. Only these
-- actions forget anything, and a test keeps this list matching the ones that do.
CREATE INDEX IF NOT EXISTS action_run_forget ON action_run (action) WHERE action IN ('playtomic.upload', 'chat.report', 'chat.stop');
