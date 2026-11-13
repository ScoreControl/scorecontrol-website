-- Private Storage bucket for score file bytes, one object per blob at `{projectId}/{sha256}`.
--
-- No storage.objects policies: anon and authenticated clients get no access at all. The server
-- authorizes every request against the project, then reads and writes with the secret key, and
-- hands browsers short-lived signed URLs for downloads.
--
-- The 25 MB limit matches the blobs.size_bytes CHECK in prisma/migrations/*_init_schema.
-- No MIME allow-list: OTHER files (PDF parts, audio) are versioned too.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('blobs', 'blobs', false, 26214400, NULL)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;
