import { createClient } from "@supabase/supabase-js";

const url = process.env.REACT_APP_SUPABASE_URL || "";
const anon = process.env.REACT_APP_SUPABASE_ANON_KEY || "";

export const CLOUD_ENABLED = Boolean(url && anon);
export const supabase = CLOUD_ENABLED ? createClient(url, anon, { auth: { persistSession: false } }) : null;

// One “tenant” id so your school’s data stays grouped.
// You can later swap to multi‑school auth; for now, this is simple and effective.
export const SCHOOL_ID = process.env.REACT_APP_SCHOOL_ID || "DEFAULT_SCHOOL";
