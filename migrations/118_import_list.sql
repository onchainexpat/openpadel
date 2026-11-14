-- The Customers page's Imports tab lists past member imports from their own runs (person.import): a club with years of
-- changes would read every one of them for it without this.
CREATE INDEX IF NOT EXISTS action_run_imports ON action_run (created_at DESC) WHERE action = 'person.import';
