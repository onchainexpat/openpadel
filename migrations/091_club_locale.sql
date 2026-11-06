-- The club's formats (a BCP 47 locale such as en-US, es-ES, en-GB, fr-FR): how dates, times, numbers and amounts are
-- written, the 12- or 24-hour clock and the first day of the week. A member's language stays their own.
ALTER TABLE club ADD COLUMN format_locale text NOT NULL DEFAULT 'en-US' CHECK (format_locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$');
