-- Optional facts are never inferred from another business role or conclusion.
ALTER TABLE inspection_record ADD COLUMN supervisor TEXT NOT NULL DEFAULT '';
ALTER TABLE inspection_record ADD COLUMN method TEXT NOT NULL DEFAULT '';
ALTER TABLE inspection_record ADD COLUMN supervised_unit TEXT NOT NULL DEFAULT '';
ALTER TABLE inspection_record ADD COLUMN findings TEXT NOT NULL DEFAULT '';
ALTER TABLE inspection_record ADD COLUMN remarks TEXT NOT NULL DEFAULT '';
