-- Prices that include tax (VAT, IVA, GST), as most of the world writes them, beside the US way (tax on top), and the
-- club's own word for the tax. A receipt keeps how it was taxed when it was issued, so a later change never rewrites it.
ALTER TABLE club ADD COLUMN prices_include_tax boolean NOT NULL DEFAULT false;
ALTER TABLE club ADD COLUMN tax_label text CHECK (tax_label IS NULL OR length(tax_label) BETWEEN 1 AND 20);
ALTER TABLE receipt ADD COLUMN tax_included boolean NOT NULL DEFAULT false;
ALTER TABLE receipt ADD COLUMN tax_label text;
ALTER TABLE receipt ADD COLUMN tax_bp int;
