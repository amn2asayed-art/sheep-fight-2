-- ============================================================
-- Sheep Fight 2 - نظام اللعب مع صديق (Friend Rooms)
-- Supabase Database Schema
-- ============================================================
-- شغّل هذا الملف في محرر SQL داخل مشروع Supabase الخاص بك:
--   Dashboard > SQL Editor > New query > لصق هذا الملف > Run
-- لمشروع جديد: افتح https://supabase.com > New project > أنشئه
-- ثم انسخ من Project Settings > API:
--   Project URL    (مثال: https://xxxx.supabase.co)
--   anon public key
--   service_role key (سرّي، لا تشاركه أبداً)

-- تعطيل RLS مؤقتاً لتبسيط الوصول من الخادم (انظر التعليقات بالأسفل)
alter table if exists public.friend_rooms disable row level security;

-- جدول الغرف: يربط بين الصديقين عبر كود واحد
create table if not exists public.friend_rooms (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,                -- كود الربط المكوّن من 6 أحرف
  host_name   text not null,                       -- اسم المضيف
  host_avatar text,                                -- معرف الأفاتار للمضيف
  host_sid    text,                                -- معرّف اتصال socket الخاص بالمضيف
  guest_name  text,                                -- اسم الضيف (يمتلئ عند الانضمام)
  guest_avatar text,
  guest_sid   text,
  status      text not null default 'waiting',     -- waiting | ready | playing | closed
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- مؤشر لحذف الغرف القديمة أو البحث عنها حسب الكود
create index if not exists idx_friend_rooms_code   on public.friend_rooms (code);
create index if not exists idx_friend_rooms_status on public.friend_rooms (status);

-- ============================================================
-- ملاحظات الأمان (الأهم من SQL نفسه):
-- 1) يُنصح بشدة بعدم تعطيل RLS في التطبيق الحقيقي.
--    بدلاً من ذلك استخدم service_role key على الخادم فقط،
--    ولا تعرّضها أبداً في المتصفح.
-- 2) تطبيق المتصفح (friend-client.js) لا يتصل بـ Supabase مباشرة،
--    بل يتصل بخادمك المحلي friend-server.js الذي يتصل بـ Supabase
--    بواسطة service_role key. بهذا لا تتسرب المفاتيح للمستخدمين.
-- ============================================================
