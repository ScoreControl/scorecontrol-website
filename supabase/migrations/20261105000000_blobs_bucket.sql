-- Private Storage bucket for score file bytes, one object per blob at {projectId}/{sha256}.
-- 25 MB per object, matching blobs_size_bytes_check. No storage.objects policies: only the server's
-- secret key (which bypasses RLS) reads and writes it, after checking project membership.
insert into storage.buckets (id, name, public, file_size_limit)
values ('blobs', 'blobs', false, 26214400)
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit;
