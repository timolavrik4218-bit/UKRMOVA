-- Run this file in Supabase SQL Editor after enabling Email Auth.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone text unique check (phone is null or phone ~ '^\+[1-9][0-9]{9,14}$'),
  full_name text not null check (char_length(trim(full_name)) between 2 and 60),
  identity_key_hash text unique check (identity_key_hash is null or identity_key_hash ~ '^[a-f0-9]{64}$'),
  identity_status text not null default 'pending' check (identity_status in ('pending', 'verified', 'rejected')),
  identity_verified_at timestamptz,
  role text not null default 'student' check (role in ('student', 'teacher', 'admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.works (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 3 and 120),
  description text not null check (char_length(trim(description)) between 3 and 2000),
  subject text not null check (subject in ('literature', 'language', 'creative')),
  theme text not null default 'Інша тема' check (char_length(trim(theme)) between 2 and 80),
  status text not null default 'pending' check (status in ('pending', 'published', 'rejected')),
  created_at timestamptz not null default now()
);

create table if not exists public.work_media (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.works(id) on delete cascade,
  file_name text not null,
  storage_path text not null unique,
  public_url text not null,
  mime_type text not null default 'application/octet-stream',
  file_size integer not null default 0 check (file_size >= 0),
  media_kind text not null default 'document' check (media_kind in ('image', 'video', 'audio', 'document', 'archive')),
  created_at timestamptz not null default now()
);

create table if not exists public.daily_lessons (
  id uuid primary key default gen_random_uuid(),
  lesson_date date not null unique default current_date,
  subject text not null default 'language' check (subject in ('language', 'literature')),
  topic text not null check (char_length(trim(topic)) between 3 and 160),
  homework text not null check (char_length(trim(homework)) between 3 and 2000),
  updated_by uuid not null references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now()
);

create table if not exists public.registration_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique check (code_hash ~ '^[a-f0-9]{64}$'),
  label text not null check (char_length(trim(label)) between 2 and 120),
  max_uses integer not null default 1 check (max_uses between 1 and 100),
  used_count integer not null default 0 check (used_count >= 0 and used_count <= max_uses),
  expires_at timestamptz,
  is_active boolean not null default true,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

-- Міграція для проєктів, де профілі були створені у старій версії з телефоном.
alter table public.profiles add column if not exists email text;
alter table public.profiles alter column phone drop not null;
alter table public.profiles alter column identity_key_hash drop not null;
alter table public.works add column if not exists theme text;
update public.works set theme = 'Інша тема' where theme is null or trim(theme) = '';
alter table public.works alter column theme set default 'Інша тема';
alter table public.works alter column theme set not null;
create unique index if not exists profiles_email_unique on public.profiles(email) where email is not null;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, phone, full_name)
  values (
    new.id,
    new.email,
    new.phone,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), 'Новий учасник')
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.works enable row level security;
alter table public.work_media enable row level security;
alter table public.daily_lessons enable row level security;
alter table public.registration_codes enable row level security;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') $$;

insert into storage.buckets (id, name, public)
values ('work-project-files', 'work-project-files', true)
on conflict (id) do update set public = true;

drop policy if exists "Anyone can view project files" on storage.objects;
drop policy if exists "Authenticated users can upload project files" on storage.objects;
drop policy if exists "Users can update project files they own" on storage.objects;
drop policy if exists "Users can delete project files they own" on storage.objects;

create policy "Anyone can view project files" on storage.objects for select using (bucket_id = 'work-project-files');
create policy "Authenticated users can upload project files" on storage.objects for insert with check (
  bucket_id = 'work-project-files' and auth.role() = 'authenticated'
);
create policy "Users can update project files they own" on storage.objects for update using (
  bucket_id = 'work-project-files' and (auth.uid() = owner or public.is_admin())
) with check (
  bucket_id = 'work-project-files' and (auth.uid() = owner or public.is_admin())
);
create policy "Users can delete project files they own" on storage.objects for delete using (
  bucket_id = 'work-project-files' and (auth.uid() = owner or public.is_admin())
);

create or replace function public.admin_delete_user(target_user_id uuid)
returns void
language plpgsql
security definer set search_path = public, auth
as $$
begin
  if not public.is_admin() then
    raise exception 'Only administrators can delete users';
  end if;
  if target_user_id = auth.uid() then
    raise exception 'Administrators cannot delete their own account';
  end if;
  delete from auth.users where id = target_user_id;
end;
$$;

create or replace function public.admin_verify_identity(target_user_id uuid, approve boolean)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only administrators can verify identities';
  end if;
  update public.profiles
  set identity_status = case when approve then 'verified' else 'rejected' end,
      identity_verified_at = case when approve then now() else null end
  where id = target_user_id;
end;
$$;

create or replace function public.claim_identity(identity_hash text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  matching_code public.registration_codes%rowtype;
begin
  if auth.uid() is null or identity_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid identity code';
  end if;
  select *
  into matching_code
  from public.registration_codes
  where code_hash = identity_hash
    and is_active
    and used_count < max_uses
    and (expires_at is null or expires_at > now())
  for update;
  if not found then
    raise exception 'Registration code is invalid, expired, or already used';
  end if;
  update public.profiles
  set identity_key_hash = identity_hash,
      identity_status = 'pending',
      identity_verified_at = null
  where id = auth.uid();
  if not found then
    raise exception 'Profile not found';
  end if;
  update public.registration_codes
  set used_count = used_count + 1,
      is_active = case when used_count + 1 >= max_uses then false else is_active end
  where id = matching_code.id;
end;
$$;

create or replace function public.create_registration_code(
  p_label text,
  p_expires_at timestamptz default null,
  p_max_uses integer default 1
)
returns table (code text, label text, max_uses integer, expires_at timestamptz)
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  generated_code text;
begin
  if not public.is_admin() then
    raise exception 'Only administrators can create registration codes';
  end if;
  if p_label is null or char_length(trim(p_label)) not between 2 and 120 then
    raise exception 'Invalid registration code label';
  end if;
  if p_max_uses not between 1 and 100 then
    raise exception 'Maximum uses must be between 1 and 100';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'Expiration must be in the future';
  end if;

  generated_code := upper(encode(gen_random_bytes(6), 'hex'));
  insert into public.registration_codes (code_hash, label, max_uses, expires_at, created_by)
  values (
    encode(digest(lower(generated_code), 'sha256'), 'hex'),
    trim(p_label),
    p_max_uses,
    p_expires_at,
    auth.uid()
  );
  return query select generated_code, trim(p_label), p_max_uses, p_expires_at;
end;
$$;

create or replace function public.admin_revoke_registration_code(target_code_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only administrators can revoke registration codes';
  end if;
  update public.registration_codes
  set is_active = false
  where id = target_code_id;
end;
$$;

revoke all on function public.admin_delete_user(uuid) from public;
grant execute on function public.admin_delete_user(uuid) to authenticated;
revoke all on function public.admin_verify_identity(uuid, boolean) from public;
grant execute on function public.admin_verify_identity(uuid, boolean) to authenticated;
revoke all on function public.claim_identity(text) from public;
grant execute on function public.claim_identity(text) to authenticated;
revoke all on function public.create_registration_code(text, timestamptz, integer) from public;
grant execute on function public.create_registration_code(text, timestamptz, integer) to authenticated;
revoke all on function public.admin_revoke_registration_code(uuid) from public;
grant execute on function public.admin_revoke_registration_code(uuid) to authenticated;

-- Профільні поля, особливо identity_key_hash та identity_status, не можна
-- змінювати через клієнт. Зміни виконує лише захищена адмінська функція.
drop policy if exists "Users can update themselves" on public.profiles;
drop policy if exists "Profiles visible to signed in users" on public.profiles;
drop policy if exists "Admins manage profiles" on public.profiles;
drop policy if exists "Published daily lessons are public" on public.daily_lessons;
drop policy if exists "Admins manage daily lessons" on public.daily_lessons;
drop policy if exists "Admins view registration codes" on public.registration_codes;
drop policy if exists "Published works are public" on public.works;
drop policy if exists "Students create own works" on public.works;
drop policy if exists "Authors update own pending works" on public.works;
drop policy if exists "Admins moderate works" on public.works;
drop policy if exists "Published work media are visible" on public.work_media;
drop policy if exists "Authors manage own work media" on public.work_media;
drop policy if exists "Admins manage work media" on public.work_media;
create policy "Profiles visible to signed in users" on public.profiles for select to authenticated using (true);
create policy "Admins manage profiles" on public.profiles for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "Published daily lessons are public" on public.daily_lessons for select using (true);
create policy "Admins manage daily lessons" on public.daily_lessons for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "Admins view registration codes" on public.registration_codes for select to authenticated using (public.is_admin());
create policy "Published works are public" on public.works for select using (status = 'published' or author_id = auth.uid() or public.is_admin());
create policy "Students create own works" on public.works for insert to authenticated with check (author_id = auth.uid());
create policy "Authors update own pending works" on public.works for update to authenticated using (author_id = auth.uid() and status = 'pending') with check (author_id = auth.uid());
create policy "Admins moderate works" on public.works for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "Published work media are visible" on public.work_media for select using (
  exists (
    select 1 from public.works w
    where w.id = work_id and (w.status = 'published' or w.author_id = auth.uid() or public.is_admin())
  )
);
create policy "Authors manage own work media" on public.work_media for all to authenticated using (
  exists (
    select 1 from public.works w
    where w.id = work_id and w.author_id = auth.uid() and w.status = 'pending'
  )
) with check (
  exists (
    select 1 from public.works w
    where w.id = work_id and w.author_id = auth.uid() and w.status = 'pending'
  )
);
create policy "Admins manage work media" on public.work_media for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- After creating the first account, promote only the teacher's verified profile:
-- update public.profiles set role = 'admin', identity_status = 'verified'
-- where email = 'teacher@example.com';
