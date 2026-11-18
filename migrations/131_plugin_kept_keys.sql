-- A key a plugin keeps itself (plugin.secret_keep, packages/core/src/plugins.ts): an OAuth refresh token that changes
-- each time it's used. The vault shows it as "kept by <plugin>". Null: added by a person, as before.
alter table vault_item add column kept_by_plugin text;
