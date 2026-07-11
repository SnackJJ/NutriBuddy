-- 0007: Tighten the user_profile write path (issue #62 / ADD §Memory).
--
-- ADD §Memory: "Writes: the validated user API only." Migration 0005
-- granted authenticated insert/update on user_profile, which let a browser
-- client write constraints directly, bypassing the profile API's
-- validation. Drop the write policies; keep select so session-scoped
-- clients can still read their own profile. The validated profile API
-- (service-role, server-side) remains the sole write door.

drop policy "Users can insert their own profile" on public.user_profile;
drop policy "Users can update their own profile" on public.user_profile;
